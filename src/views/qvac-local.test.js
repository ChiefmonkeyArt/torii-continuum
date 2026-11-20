// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { openLocalChat } from './qvac-local.js';
afterEach(()=>{ document.dispatchEvent(new Event('continuum:session-changed')); document.body.replaceChildren(); });
it('sends only entered text, streams safely, and clears the local dialog on session change', async ()=>{
  const ask=vi.fn(async(q,fn)=>{fn({type:'delta',delta:'<img>'});return {ok:true,data:{reply:'<img>'}};});
  openLocalChat(ask);
  document.querySelector('textarea').value='  Hello  ';
  await document.querySelector('form').onsubmit(new Event('submit'));
  expect(ask).toHaveBeenCalledWith('Hello',expect.any(Function));
  expect(document.querySelector('[role=status]').textContent).toBe('<img>');
  expect(document.querySelector('img')).toBeNull();
  document.dispatchEvent(new Event('continuum:session-changed'));
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('does not retry through paid chat when the local service is absent',async()=>{
  const ask=vi.fn(async()=>({ok:false})); openLocalChat(ask);
  document.querySelector('textarea').value='gm'; await document.querySelector('form').onsubmit(new Event('submit'));
  expect(ask).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain('Nothing was sent to Routstr');
});
