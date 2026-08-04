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
    return None

class Telemetry:
    """Track per-step timing + cumulative token usage from the wire stream."""
    def __init__(self):
        self.step_start_wall = None   # wall clock when step.begin seen
        self.last_event_wall = None
        self.cum_out = 0
        self.last_rate = None         # output tokens/sec of last completed step
        self.last_gap = None          # wall seconds between last two steps
        self._last_step_begin = None

    def note(self, ev):
        now = time.time()
        gap = None
        if self.last_event_wall is not None:
            gap = now - self.last_event_wall
        self.last_event_wall = now
        t = ev.get("type")
        if t == "step.begin":
            if self._last_step_begin is not None:
                self.last_gap = now - self._last_step_begin
            self._last_step_begin = now
            self.step_start_wall = now
        elif t == "step.end":
            u = ev.get("usage", {})
            out_toks = u.get("output", 0) or 0
            self.cum_out += out_toks
            dur = (now - self.step_start_wall) if self.step_start_wall else None
            rate = (out_toks / dur) if dur and dur > 0 else None
            self.last_rate = rate
            bits = [f"{out_toks:,} out-tokens"]
            if dur is not None:
                bits.append(f"in {dur:.0f}s")
            if rate:
                bits.append(f"({rate:.1f} tok/s)")
            if self.last_gap is not None:
                bits.append(f"| step gap {self.last_gap:.0f}s")
            bits.append(f"| cumulative {self.cum_out:,}")
            return "\033[33m[step end] " + " ".join(bits) + "\033[0m"
        return None

    def heartbeat(self):
        if self.last_event_wall is None:
            return None
        idle = time.time() - self.last_event_wall
        gen = (time.time() - self.step_start_wall) if self.step_start_wall else idle
        rate = f"{self.last_rate:.1f} tok/s last step" if self.last_rate else "no rate yet"
        return (f"\033[2m[waiting] {idle:.0f}s idle | step running {gen:.0f}s | "
                f"{rate} | cumulative {self.cum_out:,} out-tokens\033[0m")

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
        if show_all:
            pass  # print everything, then follow
        else:
            # Print the last N parsed events as backlog, then follow.
            # (Plain seek-to-end leaves first-time viewers staring at
            # silence whenever the agent is mid-thought.)
            backlog = []
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") == "context.append_loop_event":
                    s = fmt_event(d.get("event", {}))
                    if s:
                        backlog.append(s)
            for s in backlog[-25:]:
                print(s, flush=True)
            if backlog:
                print("\033[2m--- live ---\033[0m", flush=True)
        tele = Telemetry()
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.4)
                hb = tele.heartbeat()
                if hb and int(time.time() * 10) % 100 < 4:  # ~every 10s
                    print(hb, flush=True)
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") == "context.append_loop_event":
                ev = d.get("event", {})
                s = tele.note(ev) or fmt_event(ev)
                if s:
                    print(s, flush=True)

if __name__ == "__main__":
    main()
