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
 *
 * torii-teams ADR 0023 (docs/adr-seamless-team-chat.md): the "not joined yet"
 * count waits for the frame (no estimate first); Search opens the chat's own
 * search; the dock shows the loading ring until the frame says it is ready.
 */
import { renderProjectMissing } from './project-missing.js';
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
import { startTeamsFrame, dockTeamsFrame, teamsOrigin, chatPath, openTeamsComputers, openTeamsSearch, teamMembers, teamReady, READY_WAIT_MS, TEAM_MEMBERS_EVENT, TEAM_READY_EVENT } from '../lib/teams-frame.js';
import { loaderEl } from '../components/loader.js';
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
  if (!p) {
    renderProjectMissing(mount, slug, () => renderProjectTeam(mount, slug, deps), { go });
    return;
  }
  clear(mount);
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
    drawChat(members);
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

  function drawChat(members) {
    const humans = members.filter((m) => m.role !== 'agent');
    const faces = h('span', { class: 'project-team-faces', 'aria-hidden': 'true' });
    loadProfiles(humans.map((m) => m.pubkey)).finally(() => {
      for (const m of humans.slice(0, MAX_FACES)) faces.append(avatarEl(m.pubkey, 26));
    });
    const countEl = h('span', { class: 'muted project-team-count' });
    const setCount = (waiting) => {
      countEl.textContent = `${humans.length} ${humans.length === 1 ? 'person' : 'people'}${waiting ? ` · ${waiting} not joined yet` : ''}`;
    };
    // ADR 0023 §6: only the frame's count (who is really in); no guess first.
    setCount(teamMembers(slug)?.waiting ?? 0);
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
    const [search, searchMore] = extra(() => h('button', { class: 'ghost', type: 'button', hidden: true, onClick: () => { closeMenu(); openTeamsSearch(); } }, ['Search']));
    const [open, openMore] = extra(() => h('a', { class: 'team-chat-open', target: '_blank', rel: 'noopener noreferrer', text: 'Open in full window', hidden: true }));
    openMore.addEventListener('click', closeMenu);
    const menu = h('div', { class: 'project-team-more-menu', popover: 'auto', role: 'menu' }, [searchMore, computersMore, openMore]);
    const more = h('button', { class: 'ghost project-team-more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true, onClick: () => {
      const r = more.getBoundingClientRect();
      menu.style.top = `${Math.round(r.bottom + 4)}px`;
      menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      try { menu.togglePopover?.(); } catch { /* not supported */ }
    } }, ['More']);
    menu.addEventListener('toggle', (e) => more.setAttribute('aria-expanded', String(e.newState === 'open')));
    const dock = h('div', { class: 'team-chat-dock project-team-dock' });
    // ADR 0023 §5: our loading ring until the frame says the chat is ready
    // (the frame stays transparent over it); an older Teams: after a wait.
    const waitRing = loaderEl('Opening team chat');
    if (!teamReady(slug)) dock.append(waitRing);
    const dropRing = () => { waitRing.remove(); window.removeEventListener(TEAM_READY_EVENT, onReady); clearTimeout(ringTimer); };
    const onReady = (e) => { if (!dock.isConnected || e.detail?.slug === slug) dropRing(); };
    window.addEventListener(TEAM_READY_EVENT, onReady);
    const ringTimer = setTimeout(dropRing, READY_WAIT_MS);
    body.append(
      h('div', { class: 'project-team-head' }, [
        faces,
        countEl,
        h('span', { style: 'flex: 1;' }),
        h('button', { class: 'ghost', type: 'button', onClick: () => openTeamFor(slug, go) }, ['Add people']),
        h('span', { class: 'project-team-extras' }, [search, computers, open]),
        more,
        menu,
      ]),
      dock,
    );
    Promise.resolve(startTeamsFrame(api)).then((running) => {
      if (!dock.isConnected) return;
      const url = teamsOrigin();
      if (url) for (const a of [open, openMore]) { a.href = `${url}${chatPath(slug)}`; a.hidden = false; }
      if (running) for (const b of [search, searchMore, computers, computersMore]) b.hidden = false;
      more.hidden = !url && !running;
      if (!running || !dockTeamsFrame(dock, { projectSlug: slug })) { dropRing(); dock.append(line("Couldn't start the team chat here. Use Open in full window.")); }
    }).catch(() => {});
  }

  draw();
}
