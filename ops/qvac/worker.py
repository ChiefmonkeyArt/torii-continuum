"""One private, bounded, text-only request per socket activation."""
import asyncio
import json
import os
import sys
from tetherto.qvac_sdk import Client, completion, load_model

MODEL = "/opt/continuum-qvac/llama.gguf"
OUTPUT = None


def emit(event):
    print(json.dumps(event, ensure_ascii=False), file=OUTPUT, flush=True)


async def main():
    line = sys.stdin.buffer.readline(16385)
    if not line.endswith(b"\n") or len(line) > 16384:
        raise ValueError()
    q = json.loads(line)["question"]
    if not isinstance(q, str) or not 0 < len(q.strip().encode()) <= 2048:
        raise ValueError()
    async with Client() as client:
        t = client.transport
        model = await load_model(t, model_src=MODEL, model_type="llamacpp-completion",
                                 model_config={"device": "cpu", "threads": 2, "ctx_size": 2048}, seed=False)
        run = completion(t, model_id=model, history=[{"role": "user", "content": q}],
                         generation_params={"temp": 0, "predict": 96})
        async for event in run.events:
            if event.type == "contentDelta" and event.text:
                emit({"delta": event.text})
        await run.final
        emit({"done": True})


if __name__ == "__main__":
    OUTPUT = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)  # Native library diagnostics must never enter the reply stream.
    try:
        asyncio.run(main())
    except Exception:
        # No prompt, content or exception details in shared system logs.
        try:
            emit({"error": "local_unavailable"})
        except BrokenPipeError:
            pass
