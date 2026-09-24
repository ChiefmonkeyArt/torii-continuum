// @vitest-environment jsdom
import {test,expect,vi,afterEach} from 'vitest';
import {renderLiveModelPicker} from './routstr-model-picker.js';
const data={selected_model:'deepseek-v3.2',max_sats_per_request:50,models:[
 {id:'deepseek-v3.2',name:'DeepSeek V3.2',input_sats_per_1k:.2,output_sats_per_1k:.3},
 {id:'deepseek-v4-flash',name:'DeepSeek V4 Flash',input_sats_per_1k:.1,output_sats_per_1k:.2},
]};
const tick=()=>new Promise(r=>setTimeout(r,0));
afterEach(()=>{document.body.replaceChildren();});
test('loads server choice, searches, saves explicitly, and shows confirmed success',async()=>{
 const save=vi.fn(async model=>({ok:true,data:{selected_model:model}}));
 const card=renderLiveModelPicker({load:async()=>({ok:true,data}),save});document.body.append(card);await tick();
 const select=card.querySelector('select'),button=card.querySelector('button'),input=card.querySelector('input');
 expect(card.textContent).toContain('Current: DeepSeek V3.2');expect(button.disabled).toBe(true);
 input.value='V4';input.dispatchEvent(new Event('input'));expect(select.options.length).toBe(1);
 expect(save).not.toHaveBeenCalled();button.click();await tick();
 expect(save).toHaveBeenCalledWith('deepseek-v4-flash');expect(card.textContent).toContain('Current: DeepSeek V4 Flash');
 expect(card.textContent).toContain('No restart needed');expect(card.textContent).toContain('50-sat');
});
test('save failure preserves confirmed selection; hostile model labels are text only',async()=>{
 const card=renderLiveModelPicker({load:async()=>({ok:true,data:{...data,models:[...data.models,{id:'hostile',name:'<img src=x onerror=alert(1)>',input_sats_per_1k:0,output_sats_per_1k:0}]}}),save:async()=>({ok:false})});
 document.body.append(card);await tick();expect(card.querySelector('img')).toBeNull();
 const select=card.querySelector('select');select.value='deepseek-v4-flash';select.dispatchEvent(new Event('change'));
 card.querySelector('button').click();await tick();
 expect(card.textContent).toContain('Current: DeepSeek V3.2');expect(card.textContent).toContain('Could not save');
});
test('load errors are visible and retry works without spending',async()=>{
 const load=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,data});
 const card=renderLiveModelPicker({load});document.body.append(card);await tick();
 expect(card.textContent).toContain('Could not load models');
 [...card.querySelectorAll('button')].find(b=>b.textContent==='Refresh models').click();await tick();
 expect(card.textContent).toContain('Current: DeepSeek V3.2');
});
