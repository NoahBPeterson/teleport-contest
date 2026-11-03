// recording-env.mjs — the `recording_env` block written into each recorded
// session.json, so a recording carries the facts needed to reproduce it.
//
// Deliberately minimal and non-identifying: no hostname, username, $HOME or
// filesystem paths. Only what can change a recording's content:
//
//   recorded_at            when the recorder ran (UTC, ISO 8601)
//   tz                     TZ handed to the C process
//   tz_utc_offset_sec      that zone's UTC offset at recorded_at
//   tz_isdst               whether that zone was on DST at recorded_at
//   mktime_utc_offset_sec  the offset the recorder's mktime() applied to the
//                          session `datetime`. The recorder patch seeds tm from
//                          localtime(real now), so tm_isdst comes from the
//                          moment of recording, not from the simulated date:
//                          -14400 when recorded during EDT, -18000 during EST.
//                          The port assumes -14400 (js/boot/harness.mjs
//                          REC_UTC_OFFSET_SEC, matching the official
//                          recordings); a session with -18000 here can differ
//                          in moon phase, night(), Friday 13th and
//                          timestamp-derived shopkeeper names for reasons that
//                          are not port bugs. See docs/NOTES-recording-environment.md.
//   recorder_sha256        hash of the recorder binary (identifies the build)
//   repo_commit            git HEAD of this checkout (null if unavailable)
//   mktime_now             the epoch the recorder's mktime() took tm_isdst
//                          from (NETHACK_MKTIME_NOW, patch 010), or null if
//                          it used the real clock
//   os, os_release, arch, node   platform facts (libc behavior is platform-specific)
//
// recorderEnv() is the ONE place the C recorder's process environment is
// built, and recorderSpawn() the one place its command line is; both
// scripts/record-session.mjs and tools/play-record.mjs use them.
//
// Safety: recordings replay keys that may come from fuzzers or third-party
// recipes, and NetHack's `!` runs $SHELL (dosh(), sys/unix/unixunix.c).
// recorderEnv() sets SHELL=/usr/bin/false so `!` can never reach a real
// shell, and recorderSpawn() runs the binary under scripts/recorder.sb
// (macOS sandbox-exec: no network, writes only to the install/temp/profile
// dirs, exec only itself and compress). RECORDER_SANDBOX=0 disables the
// sandbox. Neither changes what the game prints except for `!` itself,
// which no recordable session can use anyway. sysconf (SHELLERS=*) is left
// alone on purpose: the port vendors it (js/data-nethackdir via
// tools/vendor-data.mjs) and must keep matching the official recorder.

import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** UTC offset (seconds) of IANA zone `tz` at instant `date`. */
export function zoneOffsetSec(tz, date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(date);
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
    const asUtc = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 1000);
}

/** Whether `tz` observes DST at `date` (offset above its January/July minimum). */
function zoneIsDst(tz, date) {
    const y = date.getUTCFullYear();
    const std = Math.min(zoneOffsetSec(tz, new Date(Date.UTC(y, 0, 1))),
                         zoneOffsetSec(tz, new Date(Date.UTC(y, 6, 1))));
    return zoneOffsetSec(tz, date) > std;
}

async function sha256File(p) {
    try { return createHash('sha256').update(await fs.readFile(p)).digest('hex'); }
    catch { return null; }
}

function repoCommit(cwd) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim() || null;
    } catch { return null; }
}

// The official recordings were made during EDT, so the recorder's mktime()
// read every session datetime at -04:00 (the port's REC_UTC_OFFSET_SEC).
// Pinning the clock mktime() consults to a summer instant reproduces that in
// any season. RECORDER_MKTIME_NOW=<epoch> overrides; =real uses the real clock.
export const DEFAULT_MKTIME_NOW = Math.floor(Date.UTC(2026, 7, 1, 16, 0, 0) / 1000); // 2026-08-01 12:00 EDT

/** @returns {number|null} epoch seconds for NETHACK_MKTIME_NOW, or null for the real clock */
export function resolveMktimeNow(env = process.env) {
    const v = env.RECORDER_MKTIME_NOW;
    if (v === 'real') return null;
    if (v !== undefined && v !== '') {
        const n = Number(v);
        if (!Number.isInteger(n)) throw new Error(`RECORDER_MKTIME_NOW must be epoch seconds or "real", got ${v}`);
        return n;
    }
    return DEFAULT_MKTIME_NOW;
}

/**
 * The recorder process's environment. Every recording tool builds it here.
 * @param {{installDir: string, homeDir: string, tz: string, seed: number|string,
 *          datetime: string, rngLogPath: string, mktimeNow: number|null}} o
 */
export function recorderEnv({ installDir, homeDir, tz, seed, datetime, rngLogPath, mktimeNow }) {
    const env = {
        ...process.env,
        NETHACKDIR: installDir,
        HACKDIR: installDir,
        HOME: homeDir,
        TERM: 'xterm-256color',
        TZ: tz,
        NETHACK_NO_DELAY: '1',
        NETHACK_SEED: String(seed ?? 0),
        NETHACK_FIXED_DATETIME: datetime,
        NETHACK_RNGLOG: rngLogPath,
        NOMUX_MARKERS: '1',
        NETHACK_RAW_KEYS: '1',
        // dosh() execs $SHELL: make `!` start a program that exits at once.
        SHELL: '/usr/bin/false',
    };
    delete env.NETHACK_MKTIME_NOW;
    if (mktimeNow != null) env.NETHACK_MKTIME_NOW = String(mktimeNow);
    return env;
}

const SANDBOX_PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recorder.sb');

/**
 * The command that launches the recorder: under sandbox-exec on macOS
 * (unless RECORDER_SANDBOX=0), otherwise the binary itself.
 * @param {{binary: string, args: string[], installDir: string, tmpDir: string, env: object}} o
 * @returns {{cmd: string, args: string[], sandboxed: boolean}}
 */
export function recorderSpawn({ binary, args, installDir, tmpDir, env }) {
    if (process.platform !== 'darwin' || process.env.RECORDER_SANDBOX === '0') {
        return { cmd: binary, args, sandboxed: false };
    }
    const real = (p) => realpathSync(p);
    const bin = real(binary);
    const prof = env && env.LLVM_PROFILE_FILE ? real(path.dirname(env.LLVM_PROFILE_FILE)) : real(tmpDir);
    return {
        cmd: '/usr/bin/sandbox-exec',
        args: ['-f', SANDBOX_PROFILE,
            '-D', `BIN=${bin}`, '-D', `INSTALL=${real(installDir)}`,
            '-D', `TMP=${real(tmpDir)}`, '-D', `PROF=${prof}`,
            bin, ...args],
        sandboxed: true,
    };
}

/**
 * @param {{tz: string, binary: string, repoRoot: string, mktimeNow: number|null, when?: Date}} o
 */
export async function recordingEnv({ tz, binary, repoRoot, mktimeNow, when = new Date() }) {
    const off = zoneOffsetSec(tz, when);
    const mkWhen = mktimeNow != null ? new Date(mktimeNow * 1000) : when;
    return {
        recorded_at: when.toISOString(),
        tz,
        tz_utc_offset_sec: off,
        tz_isdst: zoneIsDst(tz, when),
        // mktime() takes tm_isdst from mktime_now (or the real clock), so it
        // reads every session datetime at the zone's offset at that instant.
        mktime_now: mktimeNow ?? null,
        mktime_utc_offset_sec: zoneOffsetSec(tz, mkWhen),
        sandboxed: process.platform === 'darwin' && process.env.RECORDER_SANDBOX !== '0',
        recorder_sha256: await sha256File(binary),
        repo_commit: repoCommit(repoRoot),
        os: process.platform,
        os_release: os.release(),
        arch: process.arch,
        node: process.version,
    };
}
