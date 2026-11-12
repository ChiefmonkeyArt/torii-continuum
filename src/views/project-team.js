/**
 * A project's Team tab (docs/adr-project-team-chat.md §2): the project's own
 * chat in the one Teams frame (torii-teams ADR 0010 §2), docked full width,
 * showing only this project (torii-teams ADR 0017). People and roles stay on
 * the Team page ("Add people"). The floating assistant bar is hidden here
 * (styles/workspace.css, `.project-team-page`).
 *
 * torii-teams ADR 0021: this strip is the chat's only header. The frame has
 * none of its own inside Continuum, so Your computers lives here, and the
 * "not joined yet" count comes from the frame (who is really in the chat)
 * once it reports, with the signed list's estimate until then. On a phone,
 * Your computers and Open in full window sit in a More menu.
 */
import { h, clear } from './util.js';
import * as store from '../data/store.js';
import { navigate } from '../router.js';
import { NavLink } from '../components/nav-link.js';
import { setChatContext } from '../chat.js';
import { renderProjectTabs } from './projectHome.js';
import { parseNpub } from '../lib/npub.js';
import { readSessionMarker } from '../auth.js';
import { avatarEl, loadProfiles, setPeopleApi } from '../lib/people.js';
import { openTeamFor, startProjectChat, takeNewProject } from '../lib/team-nav.js';
import { startTeamsFrame, dockTeamsFrame, teamsOrigin, chatPath, openTeamsComputers, teamMembers, TEAM_MEMBERS_EVENT } from '../lib/teams-frame.js';
import { teamMe, teamHandoff, projectRoster, putProjectRoster, teamProfiles, teamAvatarBlob } from '../data/agent.js';

const MAX_FACES = 5;
const defaultApi = { teamMe, teamHandoff, projectRoster, putProjectRoster, teamProfiles, teamAvatarBlob };

/**
 * @param {HTMLElement} mount
 * @param {string} slug
 * @param {{api?:object, signer?:() => any, go?:(path:string) => void}} [deps]
 */
export function renderProjectTeam(mount, slug, deps = {}) {
  const api = { ...defaultApi, ...(deps.api || {}) };
  const go = deps.go || navigate;
  const getSigner = deps.signer || (() => (typeof window !== 'undefined' ? window.nostr : null));
  const p = store.getProject(slug);
  clear(mount);
  if (!p) {
    mount.appendChild(h('div', { class: 'empty' }, [
      h('div', { text: 'No project with that slug.' }),
      h('button', { style: 'margin-top: 12px', onClick: () => go('/projects') }, ['Back to projects']),
    ]));
    return;
  }
  setChatContext({ label: `${p.content.name} · Team`, where: 'project-team:' + slug });
  setPeopleApi(api);

  const page = h('div', { class: 'project-team-page' });
  const body = h('div', { class: 'project-team-body' });
  page.append(
    h('div', { class: 'crumbs' }, [
      NavLink({ href: '#/projects', children: ['Projects'] }),
      h('span', { text: '›' }),
      NavLink({ href: `#/projects/${slug}`, children: [h('span', { class: 'mono', text: slug })] }),
      h('span', { text: '›' }),
      h('span', { text: 'Team' }),
    ]),
    renderProjectTabs(slug, 'team'),
    body,
  );
  mount.appendChild(page);

  const line = (text) => h('p', { class: 'muted project-team-line', text });

  async function draw() {
    clear(body);
    body.append(line('Loading…'));
    const me = await api.teamMe().catch(() => null);
    if (!body.isConnected) return;
    clear(body);
    if (!me?.ok) { body.append(line(me?.offline ? 'The agent is offline.' : "Couldn't reach the agent.")); return; }
    if (!me.data?.teams_app_url) { body.append(line("Torii Teams isn't installed on this node, so there's no team chat.")); return; }
    if (!me.data?.owner) { body.append(line('Open Torii Teams to chat with this project.')); return; }
    const r = await api.projectRoster(slug);
    if (!body.isConnected) return;
    if (!r.ok) { body.append(line(`Couldn't load the people on this project: ${r.reason}`)); return; }
    const members = r.data?.roster?.members || [];
    // Take the new-project mark only here: the route can render twice while
    // the project hydrates, and an earlier render must not use it up.
    if (!members.length) return drawStart(takeNewProject(slug));
    takeNewProject(slug);
    drawChat(members, new Set(r.data?.teams?.added || []));
  }

  function drawStart(auto) {
    const status = h('div', { class: 'muted', role: 'status', style: 'min-height: 18px; font-size: 12.5px;' });
    const setStatus = (t, err = false) => { status.textContent = t; status.style.color = err ? 'var(--accent-danger)' : ''; };
    let busy = false;
    const start = async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      const owner = parseNpub(readSessionMarker()?.npub || '');
      const s = await startProjectChat({ api, slug, signer: getSigner(), ownerHex: owner.ok ? owner.hex : null, onStatus: setStatus });
      busy = false;
      button.disabled = false;
      if (!s.ok) { setStatus(s.reason, true); return; }
      draw();
    };
    const button = h('button', { class: 'primary', type: 'button', onClick: start }, ['Start team chat']);
    body.append(h('div', { class: 'card project-team-start' }, [
      h('p', { style: 'margin: 0 0 10px;', text: 'This project has no team chat yet. Starting it signs a member list with just you; add people after.' }),
      button,
      status,
    ]));
    if (auto) start();
  }

  function drawChat(members, added) {
    const humans = members.filter((m) => m.role !== 'agent');
    const notJoined = humans.filter((m) => m.role !== 'owner' && !added.has(m.pubkey)).length;
    const faces = h('span', { class: 'project-team-faces', 'aria-hidden': 'true' });
    loadProfiles(humans.map((m) => m.pubkey)).finally(() => {
      for (const m of humans.slice(0, MAX_FACES)) faces.append(avatarEl(m.pubkey, 26));
    });
    const countEl = h('span', { class: 'muted project-team-count' });
    const setCount = (waiting) => {
      countEl.textContent = `${humans.length} ${humans.length === 1 ? 'person' : 'people'}${waiting ? ` · ${waiting} not joined yet` : ''}`;
    };
    setCount(teamMembers(slug)?.waiting ?? notJoined);
    const onMembers = (e) => {
      if (!countEl.isConnected) { window.removeEventListener(TEAM_MEMBERS_EVENT, onMembers); return; }
      if (e.detail?.slug === slug) setCount(e.detail.waiting);
    };
    window.addEventListener(TEAM_MEMBERS_EVENT, onMembers);
    // Each control twice: inline on wide screens, in More on a phone (CSS).
    const extra = (make) => [make(), make()];
    // The menu is a popover: the browser's top layer is the only place above
    // the docked frame, which sits over the whole page (teams-frame.js).
    const closeMenu = () => { try { menu.hidePopover?.(); } catch { /* not open */ } };
    const [computers, computersMore] = extra(() => h('button', { class: 'ghost', type: 'button', hidden: true, onClick: () => { closeMenu(); openTeamsComputers(); } }, ['Your computers']));
    const [open, openMore] = extra(() => h('a', { class: 'team-chat-open', target: '_blank', rel: 'noopener noreferrer', text: 'Open in full window', hidden: true }));
    openMore.addEventListener('click', closeMenu);
    const menu = h('div', { class: 'project-team-more-menu', popover: 'auto', role: 'menu' }, [computersMore, openMore]);
    const more = h('button', { class: 'ghost project-team-more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true, onClick: () => {
      const r = more.getBoundingClientRect();
      menu.style.top = `${Math.round(r.bottom + 4)}px`;
      menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      try { menu.togglePopover?.(); } catch { /* not supported */ }
    } }, ['More']);
    menu.addEventListener('toggle', (e) => more.setAttribute('aria-expanded', String(e.newState === 'open')));
    const dock = h('div', { class: 'team-chat-dock project-team-dock' });
    body.append(
      h('div', { class: 'project-team-head' }, [
        faces,
        countEl,
        h('span', { style: 'flex: 1;' }),
        h('button', { class: 'ghost', type: 'button', onClick: () => openTeamFor(slug, go) }, ['Add people']),
        h('span', { class: 'project-team-extras' }, [computers, open]),
        more,
        menu,
      ]),
      dock,
    );
    Promise.resolve(startTeamsFrame(api)).then((running) => {
      if (!dock.isConnected) return;
      const url = teamsOrigin();
      if (url) for (const a of [open, openMore]) { a.href = `${url}${chatPath(slug)}`; a.hidden = false; }
      if (running) for (const b of [computers, computersMore]) b.hidden = false;
      more.hidden = !url && !running;
      if (!running || !dockTeamsFrame(dock, { projectSlug: slug })) dock.append(line("Couldn't start the team chat here. Use Open in full window."));
    }).catch(() => {});
  }

  draw();
}
