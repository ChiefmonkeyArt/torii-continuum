import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 86400000;
const fingerprint = (url, model) => createHash('sha256').update(JSON.stringify([url,model])).digest('hex');

// A routing hint, never authority to use a new origin or change the model.
// The file contains only a fingerprint and timestamp. No wallet or chat data.
export function routeMemory(path, now) {
  let last, loaded, writes = Promise.resolve();
  const hints = new Map();
  const load = () => loaded ??= readFile(path,'utf8').then(text=>{
    const x=JSON.parse(text);
    if (/^[a-f0-9]{64}$/.test(x?.id) && Number.isSafeInteger(x.at)) last=x;
  }).catch(()=>{});
  return {
    async prefer(list) {
      await load();
      if (!last || last.at>now() || last.at+DAY<=now()) return list;
      const i=list.findIndex(c=>fingerprint(c.baseUrl,c.model.id)===last.id);
      return i>0 ? [list[i], ...list.slice(0,i), ...list.slice(i+1)] : list;
    },
    async success(url,model) {
      await load(); const id=fingerprint(url,model), at=now();
      if (last?.id===id && at>=last.at && at-last.at<3600000) return;
      last={id,at};
      writes=writes.then(async()=>{
        const temp=`${path}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(path),{recursive:true,mode:0o700});
          await writeFile(temp,JSON.stringify({id,at}),{flag:'wx',mode:0o600});
          await rename(temp,path);
        } finally { await unlink(temp).catch(()=>{}); }
      }).catch(()=>{}); // Cache failure must never lose a paid reply.
      await writes;
    },
    quote(url,model) {
      const hint=hints.get(fingerprint(url,model));
      return hint && hint.until>now() ? hint.sats : 0;
    },
    learn(url,model,sats) {
      if (!sats) return;
      const k=fingerprint(url,model); hints.delete(k); hints.set(k,{sats,until:now()+600000});
      if(hints.size>200) hints.delete(hints.keys().next().value);
    },
  };
}

// Only recognize explicit Routstr minimum-balance contracts, never return or
// persist provider prose. Limit time and bytes even on a malformed response.
export async function readMinimum(res) {
  const reader=res.body?.getReader();
  if (!reader) return 0;
  const timer=setTimeout(()=>{void reader.cancel().catch(()=>{});},300);
  const chunks=[]; let n=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done) break;
      if((n+=value.byteLength)>8192) return 0;
      chunks.push(value);
    }
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const d=body.detail ?? body, e=d.error ?? d;
    if(!['minimum_balance_required','insufficient_balance'].includes(e.code ?? d.type)) return 0;
    const msg=typeof e.message==='string'?e.message:'';
    const msat=e.required_msats ?? d.amount_required_msat ??
      Number(msg.match(/^Insufficient balance: (\d+) mSats required\b/i)?.[1] ??
        msg.match(/^Insufficient balance: [\d.]+ sats \((\d+) msats\) required\b/i)?.[1]);
    return Number.isSafeInteger(msat) && msat>0 ? Math.ceil(msat/1000) : 0;
  } catch {return 0;}
  finally {clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
