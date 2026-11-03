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
//   os, os_release, arch, node   platform facts (libc behavior is platform-specific)

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

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

/**
 * @param {{tz: string, binary: string, repoRoot: string, when?: Date}} o
 */
export async function recordingEnv({ tz, binary, repoRoot, when = new Date() }) {
    const off = zoneOffsetSec(tz, when);
    return {
        recorded_at: when.toISOString(),
        tz,
        tz_utc_offset_sec: off,
        tz_isdst: zoneIsDst(tz, when),
        // tm_isdst is inherited from "now", so mktime() interprets every
        // session datetime at the zone's current offset.
        mktime_utc_offset_sec: off,
        recorder_sha256: await sha256File(binary),
        repo_commit: repoCommit(repoRoot),
        os: process.platform,
        os_release: os.release(),
        arch: process.arch,
        node: process.version,
    };
}
