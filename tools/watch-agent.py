#!/usr/bin/env python3
"""watch-agent.py — live-follow a Kimi Code agent's wire log.

Usage:
  python3 tools/watch-agent.py [agent-id] [--all] [--session DIR]

  agent-id:   main, agent-5, ... (default: most recently active agent)
  --all:      print backlog instead of only new events
  --session:  explicit session dir (default: newest for this repo)

Prints a readable stream: assistant text, thinking (truncated),
tool calls (name + brief args), tool results (truncated), and
per-step token usage. Ctrl-C to stop.
"""

import json
import os
import sys
import time
import glob

def find_session(repo_root):
    home = os.path.expanduser("~/.kimi-code/sessions")
    pats = [f"wd_{os.path.basename(repo_root)}_*",
            f"wd_{os.path.basename(os.path.dirname(repo_root))}_*"]
    cands = []
    for p in pats:
        cands += glob.glob(os.path.join(home, p, "session_*"))
    if not cands:
        sys.exit("no session dir found")
    return max(cands, key=os.path.getmtime)

def fmt_event(ev):
    t = ev.get("type")
    if t == "content.part":
        part = ev.get("part", {})
        if part.get("type") == "think":
            txt = part.get("think", "").replace("\n", " ")
            return f"\033[2m[think] {txt[:140]}\033[0m"
        txt = part.get("text", "")
        if txt.strip():
            return f"\033[1m[text]\033[0m {txt[:400]}"
    elif t == "tool.call":
        name = ev.get("name", "?")
        args = ev.get("args", {})
        brief = args.get("command") or args.get("path") or args.get("pattern") or args.get("description") or json.dumps(args)[:120]
        brief = str(brief).replace("\n", " ")[:160]
        return f"\033[36m[call]\033[0m {name}: {brief}"
    elif t == "tool.result":
        out = ev.get("result", {})
        out = out.get("output") if isinstance(out, dict) else str(out)
        if out is None:
            return None
        out = str(out).replace("\n", " | ")[:200]
        return f"\033[2m[done] {out}\033[0m"
    elif t == "step.end":
        u = ev.get("usage", {})
        tot = sum(v for v in u.values() if isinstance(v, int))
        return f"\033[33m[step end] tokens this step: {tot:,}\033[0m"
    return None

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_all = "--all" in sys.argv
    session = None
    if "--session" in sys.argv:
        session = sys.argv[sys.argv.index("--session") + 1]
    repo = os.getcwd()
    session = session or find_session(repo)
    if args:
        agent = args[0]
    else:
        agents = glob.glob(os.path.join(session, "agents", "*"))
        agent = os.path.basename(max(agents, key=os.path.getmtime))
    wire = os.path.join(session, "agents", agent, "wire.jsonl")
    print(f"watching {wire}")
    if not os.path.exists(wire):
        sys.exit("no such wire file")

    with open(wire) as f:
        if not show_all:
            f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.4)
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") == "context.append_loop_event":
                s = fmt_event(d.get("event", {}))
                if s:
                    print(s, flush=True)

if __name__ == "__main__":
    main()
