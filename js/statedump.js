// statedump.js — JS side of the hidden-state oracle (patch 009 twin).
//
// Produces per-input-boundary dumps of *hidden* game state in exactly
// the JSON shape the patched C recorder writes to NETHACK_STATEDUMP
// (see nethack-c/patches/009-state-dump.patch). The comparator
// (tools/oracle-diff.mjs) walks the two dumps and reports the first
// field that disagrees — catching state bugs that screens hide
// (xeophon's grid bug sat three squares off for 60 keystrokes with
// identical screens; hp-less kills pass screen tests but not this).
//
// Technique credit: Owen Lockwood's "oracle" (David Bau,
// "Hunting Zombies", 2026-07-16).
//
// This dump is dev-only tooling: it runs only when the harness sets
// TELEPORT_STATE_DUMP, and is never read by scoring code.
//
// Field contract (must match the C dump key-for-key):
//   { moves, dnum, dlevel,
//     hero: { x, y, hp, hpmax, pw, pwmax, hunger, lvl, exp, gold,
//             luck, str, dex, con, int, wis, cha },
//     mons: [ { id, pm, x, y, hp, hpmax, mlvl, tame, peace, flee,
//               fleetim, sleep, canmove, conf, stun, speed,
//               mux, muy, strat } ],   // fmon CHAIN ORDER
//     inv:  [ { id, otyp, quan, oc, let, spe, worn, buc, known,
//               dknown, bknown, eroded, eroded2 } ] }

/**
 * @typedef {Object} OracleDump
 * @property {number} moves
 * @property {number} dnum
 * @property {number} dlevel
 * @property {Object} hero
 * @property {Object[]} mons
 * @property {Object[]} inv
 */

/**
 * Snapshot the hidden game state at an input boundary.
 * Fields that have no counterpart in the JS port yet are reported as
 * null/empty so the comparator flags them as missing rather than
 * silently skipping them.
 *
 * @param {Object} g - the global game state (gstate.js `game`)
 * @returns {OracleDump}
 */
export function dumpState(g) {
    const u = g?.u || {};
    const acurr = u.acurr?.a || [];
    return {
        moves: g?.moves ?? null,
        dnum: u.uz?.dnum ?? null,
        dlevel: u.uz?.dlevel ?? null,
        hero: {
            x: u.ux ?? null,
            y: u.uy ?? null,
            hp: u.uhp ?? null,
            hpmax: u.uhpmax ?? null,
            pw: u.uen ?? null,
            pwmax: u.uenmax ?? null,
            hunger: u.uhs ?? null,
            lvl: u.ulevel ?? null,
            exp: u.uexp ?? null,
            gold: u.ugold ?? null,
            luck: u.uluck ?? null,
            str: acurr[0] ?? null,
            dex: acurr[1] ?? null,
            con: acurr[2] ?? null,
            int: acurr[3] ?? null,
            wis: acurr[4] ?? null,
            cha: acurr[5] ?? null,
        },
        mons: dumpMonsters(g),
        inv: dumpInvent(g),
    };
}

/**
 * Monster chain in fmon order. The skeleton keeps no monster chain yet;
 * whatever list the port maintains must be walked in C's chain order
 * (newest-first, matching fmon).
 *
 * @param {Object} g
 * @returns {Object[]}
 */
function dumpMonsters(g) {
    const list = g?.fmon || g?.level?.monsters || [];
    return list.map((m) => ({
        id: m.m_id ?? m.id ?? null,
        pm: m.mnum ?? m.pm ?? null,
        x: m.mx ?? m.x ?? null,
        y: m.my ?? m.y ?? null,
        hp: m.mhp ?? null,
        hpmax: m.mhpmax ?? null,
        mlvl: m.m_lev ?? null,
        tame: m.mtame ?? null,
        peace: m.mpeaceful ?? null,
        flee: m.mflee ?? null,
        fleetim: m.mfleetim ?? null,
        sleep: m.msleeping ?? null,
        canmove: m.mcanmove ?? null,
        conf: m.mconf ?? null,
        stun: m.mstun ?? null,
        speed: m.mspeed ?? null,
        mux: m.mux ?? null,
        muy: m.muy ?? null,
        strat: m.mstrategy ?? null,
    }));
}

/**
 * Inventory chain (gi.invent order).
 *
 * @param {Object} g
 * @returns {Object[]}
 */
function dumpInvent(g) {
    const list = g?.invent || [];
    return list.map((o) => ({
        id: o.o_id ?? null,
        otyp: o.otyp ?? null,
        quan: o.quan ?? null,
        oc: o.oclass ?? null,
        let: o.invlet ?? null,
        spe: o.spe ?? null,
        worn: o.owornmask ?? null,
        buc: o.blessed ? 2 : o.cursed ? 1 : 0,
        known: o.known ?? null,
        dknown: o.dknown ?? null,
        bknown: o.bknown ?? null,
        eroded: o.oeroded ?? null,
        eroded2: o.oeroded2 ?? null,
    }));
}
