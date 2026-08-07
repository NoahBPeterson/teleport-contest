// themerms-fns.mjs — dat/themerms.lua's functions and tables, as pure JS.
//
// Everything the chunk defines, parameterised by an `api` and importing
// nothing — the same split js/lua-js/nhlib-fns.mjs has from
// js/lua-js/scripts/nhlib.mjs, and for the same two reasons:
//
//   * the game side (js/lua-js/scripts/themerms.mjs) hands it the bridge's api,
//     so every des.* / selection.* / obj.* call goes into gl.luathemes[dnum];
//   * tools/lua-port-gen/lua2des.mjs's checkChunk() hands it a recording stub
//     and compares its call stream, call for call and argument for argument,
//     with the one dat/themerms.lua's own statements produce under the same
//     RNG — which needs this file to be importable without the transpiled game
//     in scope.
//
// The comments are the .lua's, kept where the .lua has them.

export function makeThemerms(api) {
    const {
        des, selection, obj, string, nh, percent, shuffle, d, math, align,
        type, pline, luaList, luaLen, keepValue,
    } = api;

    // themerms.lua:42 — `local postprocess = { }`. A file-scope local, i.e. one
    // queue per chunk load, drained and reset by post_level_generate().
    let postprocess = [];

    /** `table.insert(t, v)` on a sequence. */
    const insert = (t, v) => { t[t.length] = v; };

    const themeroom_fills = luaList(

        {
            name: 'Ice room',
            contents: (rm) => {
                const ice = selection.room();
                des.terrain(ice, 'I');
                if (percent(25)) {
                    const mintime = 1000 - (nh.level_difficulty() * 100);
                    const ice_melter = (x, y) => {
                        nh.start_timer_at(x, y, 'melt-ice', mintime + nh.rn2(1000));
                    };
                    selection.iterate(ice, ice_melter);
                }
            },
        },

        {
            name: 'Cloud room',
            contents: (rm) => {
                const fog = selection.room();
                for (let i = 1, iEnd = (selection.numpoints(fog) / 4); i <= iEnd; i++) {
                    des.monster({ id: 'fog cloud', asleep: true });
                }
                des.gas_cloud({ selection: fog });
            },
        },

        {
            name: 'Boulder room',
            mindiff: 4,
            contents: (rm) => {
                const locs = selection.percentage(selection.room(), 30);
                const func = (x, y) => {
                    if (percent(50)) {
                        des.object('boulder', x, y);
                    } else {
                        des.trap('rolling boulder', x, y);
                    }
                };
                selection.iterate(locs, func);
            },
        },

        {
            name: 'Spider nest',
            contents: (rm) => {
                const spooders = nh.level_difficulty() > 8;
                const locs = selection.percentage(selection.room(), 30);
                const func = (x, y) => {
                    des.trap({
                        type: 'web', x, y,
                        spider_on_web: spooders && percent(80),
                    });
                };
                selection.iterate(locs, func);
            },
        },

        {
            name: 'Trap room',
            contents: (rm) => {
                const traps = luaList('arrow', 'dart', 'falling rock', 'bear',
                    'land mine', 'sleep gas', 'rust',
                    'anti magic');
                shuffle(traps);
                const locs = selection.percentage(selection.room(), 30);
                const func = (x, y) => {
                    des.trap(traps[1], x, y);
                };
                selection.iterate(locs, func);
            },
        },

        {
            name: 'Garden',
            eligible: (rm) => rm.lit === true,
            contents: (rm) => {
                const s = selection.room();
                const npts = (selection.numpoints(s) / 6);
                for (let i = 1; i <= npts; i++) {
                    des.monster({ id: 'wood nymph', asleep: true });
                    if (percent(30)) {
                        des.feature('fountain');
                    }
                }
                // The selection escapes into `postprocess` and is read by
                // make_garden_walls() after the level is finished, so its
                // registry reference outlives this call; post_level_generate()
                // releases it. See the module header.
                insert(postprocess, {
                    handler: make_garden_walls,
                    data: { sel: keepValue(selection.room()) },
                });
            },
        },

        {
            name: 'Buried treasure',
            contents: (rm) => {
                des.object({
                    id: 'chest',
                    buried: true,
                    contents: (otmp) => {
                        const xobj = obj.totable(otmp);
                        // keep track of the last buried treasure
                        if (xobj.NO_OBJ == null) {
                            insert(postprocess, {
                                handler: make_dig_engraving,
                                data: { x: xobj.ox, y: xobj.oy },
                            });
                        }
                        for (let i = 1, iEnd = d(3, 4); i <= iEnd; i++) {
                            des.object();
                        }
                    },
                });
            },
        },

        {
            name: 'Buried zombies',
            contents: (rm) => {
                const diff = nh.level_difficulty();
                // start with [1..4] for low difficulty
                const zombifiable = luaList('kobold', 'gnome', 'orc', 'dwarf');
                if (diff > 3) {          // medium difficulty
                    zombifiable[5] = 'elf'; zombifiable[6] = 'human';
                    if (diff > 6) {       // high difficulty (relatively speaking)
                        zombifiable[7] = 'ettin'; zombifiable[8] = 'giant';
                    }
                }
                for (let i = 1, iEnd = (rm.width * rm.height) / 2; i <= iEnd; i++) {
                    shuffle(zombifiable);
                    const o = des.object({
                        id: 'corpse', montype: zombifiable[1],
                        buried: true,
                    });
                    obj.stop_timer(o, 'rot-corpse');
                    obj.start_timer(o, 'zombify-mon', math.random(990, 1010));
                }
            },
        },

        {
            name: 'Massacre',
            contents: (rm) => {
                const mon = luaList('apprentice', 'warrior', 'ninja', 'thug',
                    'hunter', 'acolyte', 'abbot', 'page',
                    'attendant', 'neanderthal', 'chieftain',
                    'student', 'wizard', 'valkyrie', 'tourist',
                    'samurai', 'rogue', 'ranger', 'priestess',
                    'priest', 'monk', 'knight', 'healer',
                    'cavewoman', 'caveman', 'barbarian',
                    'archeologist');
                let idx = math.random(luaLen(mon));
                for (let i = 1, iEnd = d(5, 5); i <= iEnd; i++) {
                    if (percent(10)) { idx = math.random(luaLen(mon)); }
                    des.object({ id: 'corpse', montype: mon[idx] });
                }
            },
        },

        {
            name: 'Statuary',
            contents: (rm) => {
                for (let i = 1, iEnd = d(5, 5); i <= iEnd; i++) {
                    des.object({ id: 'statue' });
                }
                for (let i = 1, iEnd = d(3); i <= iEnd; i++) {
                    des.trap('statue');
                }
            },
        },

        {
            name: 'Light source',
            eligible: (rm) => rm.lit === false,
            contents: (rm) => {
                des.object({ id: 'oil lamp', lit: true });
            },
        },

        {
            name: 'Temple of the gods',
            contents: (rm) => {
                des.altar({ align: align[1] });
                des.altar({ align: align[2] });
                des.altar({ align: align[3] });
            },
        },

        {
            name: 'Ghost of an Adventurer',
            contents: (rm) => {
                const loc = selection.rndcoord(selection.room(), 0);
                des.monster({
                    id: 'ghost', asleep: true, waiting: true,
                    coord: loc,
                });
                if (percent(65)) {
                    des.object({ id: 'dagger', coord: loc, buc: 'not-blessed' });
                }
                if (percent(55)) {
                    des.object({ class: ')', coord: loc, buc: 'not-blessed' });
                }
                if (percent(45)) {
                    des.object({ id: 'bow', coord: loc, buc: 'not-blessed' });
                    des.object({ id: 'arrow', coord: loc, buc: 'not-blessed' });
                }
                if (percent(65)) {
                    des.object({ class: '[', coord: loc, buc: 'not-blessed' });
                }
                if (percent(20)) {
                    des.object({ class: '=', coord: loc, buc: 'not-blessed' });
                }
                if (percent(20)) {
                    des.object({ class: '?', coord: loc, buc: 'not-blessed' });
                }
            },
        },

        {
            name: 'Storeroom',
            contents: (rm) => {
                const locs = selection.percentage(selection.room(), 30);
                const func = (x, y) => {
                    if (percent(25)) {
                        des.object('chest');
                    } else {
                        des.monster({ class: 'm', appear_as: 'obj:chest' });
                    }
                };
                selection.iterate(locs, func);
            },
        },

        {
            name: 'Teleportation hub',
            contents: (rm) => {
                const locs = selection.filter_mapchar(selection.room(), '.');
                for (let i = 1, iEnd = 2 + nh.rn2(3); i <= iEnd; i++) {
                    const pos = selection.rndcoord(locs, 1);
                    if (pos.x > 0) {
                        pos.x = pos.x + rm.region.x1 - 1;
                        pos.y = pos.y + rm.region.y1;
                        insert(postprocess, {
                            handler: make_a_trap,
                            data: {
                                type: 'teleport', seen: true,
                                coord: pos, teledest: 1,
                            },
                        });
                    }
                }
            },
        },
    );

    const themerooms = luaList(
        {
            name: 'default',
            frequency: 1000,
            contents: () => {
                des.room({ type: 'ordinary', filled: 1 });
            },
        },

        {
            name: 'Fake Delphi',
            contents: () => {
                des.room({
                    type: 'ordinary', w: 11, h: 9, filled: 1,
                    contents: () => {
                        des.room({
                            type: 'ordinary', x: 4, y: 3, w: 3, h: 3,
                            filled: 1,
                            contents: () => {
                                des.door({ state: 'random', wall: 'all' });
                            },
                        });
                    },
                });
            },
        },

        {
            name: 'Room in a room',
            contents: () => {
                des.room({
                    type: 'ordinary', filled: 1,
                    contents: () => {
                        des.room({
                            type: 'ordinary',
                            contents: () => {
                                des.door({ state: 'random', wall: 'all' });
                            },
                        });
                    },
                });
            },
        },

        {
            name: 'Huge room with another room inside',
            contents: () => {
                des.room({
                    type: 'ordinary', w: nh.rn2(10) + 11, h: nh.rn2(5) + 8,
                    filled: 1,
                    contents: () => {
                        if (percent(90)) {
                            des.room({
                                type: 'ordinary', filled: 1,
                                contents: () => {
                                    des.door({ state: 'random', wall: 'all' });
                                    if (percent(50)) {
                                        des.door({ state: 'random', wall: 'all' });
                                    }
                                },
                            });
                        }
                    },
                });
            },
        },

        {
            name: 'Nesting rooms',
            contents: () => {
                des.room({
                    type: 'ordinary', w: 9 + nh.rn2(4), h: 9 + nh.rn2(4),
                    filled: 1,
                    contents: (rm) => {
                        const wid = math.random(math.floor(rm.width / 2), rm.width - 2);
                        const hei = math.random(math.floor(rm.height / 2),
                            rm.height - 2);
                        des.room({
                            type: 'ordinary', w: wid, h: hei, filled: 1,
                            contents: () => {
                                if (percent(90)) {
                                    des.room({
                                        type: 'ordinary', filled: 1,
                                        contents: () => {
                                            des.door({ state: 'random', wall: 'all' });
                                            if (percent(15)) {
                                                des.door({ state: 'random', wall: 'all' });
                                            }
                                        },
                                    });
                                }
                                des.door({ state: 'random', wall: 'all' });
                                if (percent(15)) {
                                    des.door({ state: 'random', wall: 'all' });
                                }
                            },
                        });
                    },
                });
            },
        },

        {
            name: 'Default room with themed fill',
            frequency: 6,
            contents: () => {
                des.room({ type: 'themed', contents: themeroom_fill });
            },
        },

        {
            name: 'Unlit room with themed fill',
            frequency: 2,
            contents: () => {
                des.room({ type: 'themed', lit: 0, contents: themeroom_fill });
            },
        },

        {
            name: 'Room with both normal contents and themed fill',
            frequency: 2,
            contents: () => {
                des.room({ type: 'themed', filled: 1, contents: themeroom_fill });
            },
        },

        {
            name: 'Pillars',
            contents: () => {
                des.room({
                    type: 'themed', w: 10, h: 10,
                    contents: (rm) => {
                        const terr = luaList('-', '-', '-', '-', 'L', 'P', 'T');
                        shuffle(terr);
                        for (let x = 0; x <= (rm.width / 4) - 1; x++) {
                            for (let y = 0; y <= (rm.height / 4) - 1; y++) {
                                des.terrain({ x: x * 4 + 2, y: y * 4 + 2, typ: terr[1], lit: -2 });
                                des.terrain({ x: x * 4 + 3, y: y * 4 + 2, typ: terr[1], lit: -2 });
                                des.terrain({ x: x * 4 + 2, y: y * 4 + 3, typ: terr[1], lit: -2 });
                                des.terrain({ x: x * 4 + 3, y: y * 4 + 3, typ: terr[1], lit: -2 });
                            }
                        }
                    },
                });
            },
        },

        {
            name: 'Mausoleum',
            contents: () => {
                des.room({
                    type: 'themed', w: 5 + nh.rn2(3) * 2, h: 5 + nh.rn2(3) * 2,
                    contents: (rm) => {
                        des.room({
                            type: 'themed',
                            x: (rm.width - 1) / 2, y: (rm.height - 1) / 2,
                            w: 1, h: 1, joined: false,
                            contents: () => {
                                if (percent(50)) {
                                    const mons = luaList('M', 'V', 'L', 'Z');
                                    shuffle(mons);
                                    des.monster({ class: mons[1], x: 0, y: 0, waiting: 1 });
                                } else {
                                    des.object({ id: 'corpse', montype: '@', coord: [0, 0] });
                                }
                                if (percent(20)) {
                                    des.door({ state: 'secret', wall: 'all' });
                                }
                            },
                        });
                    },
                });
            },
        },

        {
            name: 'Random dungeon feature in the middle of an odd-sized room',
            contents: () => {
                const wid = 3 + (nh.rn2(3) * 2);
                const hei = 3 + (nh.rn2(3) * 2);
                des.room({
                    type: 'ordinary', filled: 1, w: wid, h: hei,
                    contents: (rm) => {
                        const feature = luaList('C', 'L', 'I', 'P', 'T');
                        shuffle(feature);
                        des.terrain((rm.width - 1) / 2, (rm.height - 1) / 2,
                            feature[1]);
                    },
                });
            },
        },

        {
            name: 'L-shaped',
            contents: () => {
                des.map({
                    map: `-----xxx
|...|xxx
|...|xxx
|...----
|......|
|......|
|......|
--------`,
                    contents: (m) => { filler_region(1, 1); },
                });
            },
        },

        {
            name: 'L-shaped, rot 1',
            contents: () => {
                des.map({
                    map: `xxx-----
xxx|...|
xxx|...|
----...|
|......|
|......|
|......|
--------`,
                    contents: (m) => { filler_region(5, 1); },
                });
            },
        },

        {
            name: 'L-shaped, rot 2',
            contents: () => {
                des.map({
                    map: `--------
|......|
|......|
|......|
----...|
xxx|...|
xxx|...|
xxx-----`,
                    contents: (m) => { filler_region(1, 1); },
                });
            },
        },

        {
            name: 'L-shaped, rot 3',
            contents: () => {
                des.map({
                    map: `--------
|......|
|......|
|......|
|...----
|...|xxx
|...|xxx
-----xxx`,
                    contents: (m) => { filler_region(1, 1); },
                });
            },
        },

        {
            name: 'Blocked center',
            contents: () => {
                des.map({
                    map: `-----------
|.........|
|.........|
|.........|
|...LLL...|
|...LLL...|
|...LLL...|
|.........|
|.........|
|.........|
-----------`,
                    contents: (m) => {
                        if (percent(30)) {
                            const terr = luaList('-', 'P');
                            shuffle(terr);
                            des.replace_terrain({
                                region: [1, 1, 9, 9],
                                fromterrain: 'L',
                                toterrain: terr[1],
                            });
                        }
                        filler_region(1, 1);
                    },
                });
            },
        },

        {
            name: 'Circular, small',
            contents: () => {
                des.map({
                    map: `xx---xx
x--.--x
--...--
|.....|
--...--
x--.--x
xx---xx`,
                    contents: (m) => { filler_region(3, 3); },
                });
            },
        },

        {
            name: 'Circular, medium',
            contents: () => {
                des.map({
                    map: `xx-----xx
x--...--x
--.....--
|.......|
|.......|
|.......|
--.....--
x--...--x
xx-----xx`,
                    contents: (m) => { filler_region(4, 4); },
                });
            },
        },

        {
            name: 'Circular, big',
            contents: () => {
                des.map({
                    map: `xxx-----xxx
x---...---x
x-.......-x
--.......--
|.........|
|.........|
|.........|
--.......--
x-.......-x
x---...---x
xxx-----xxx`,
                    contents: (m) => { filler_region(5, 5); },
                });
            },
        },

        {
            name: 'T-shaped',
            contents: () => {
                des.map({
                    map: `xxx-----xxx
xxx|...|xxx
xxx|...|xxx
----...----
|.........|
|.........|
|.........|
-----------`,
                    contents: (m) => { filler_region(5, 5); },
                });
            },
        },

        {
            name: 'T-shaped, rot 1',
            contents: () => {
                des.map({
                    map: `-----xxx
|...|xxx
|...|xxx
|...----
|......|
|......|
|......|
|...----
|...|xxx
|...|xxx
-----xxx`,
                    contents: (m) => { filler_region(2, 2); },
                });
            },
        },

        {
            name: 'T-shaped, rot 2',
            contents: () => {
                des.map({
                    map: `-----------
|.........|
|.........|
|.........|
----...----
xxx|...|xxx
xxx|...|xxx
xxx-----xxx`,
                    contents: (m) => { filler_region(2, 2); },
                });
            },
        },

        {
            name: 'T-shaped, rot 3',
            contents: () => {
                des.map({
                    map: `xxx-----
xxx|...|
xxx|...|
----...|
|......|
|......|
|......|
----...|
xxx|...|
xxx|...|
xxx-----`,
                    contents: (m) => { filler_region(5, 5); },
                });
            },
        },

        {
            name: 'S-shaped',
            contents: () => {
                des.map({
                    map: `-----xxx
|...|xxx
|...|xxx
|...----
|......|
|......|
|......|
----...|
xxx|...|
xxx|...|
xxx-----`,
                    contents: (m) => { filler_region(2, 2); },
                });
            },
        },

        {
            name: 'S-shaped, rot 1',
            contents: () => {
                des.map({
                    map: `xxx--------
xxx|......|
xxx|......|
----......|
|......----
|......|xxx
|......|xxx
--------xxx`,
                    contents: (m) => { filler_region(5, 5); },
                });
            },
        },

        {
            name: 'Z-shaped',
            contents: () => {
                des.map({
                    map: `xxx-----
xxx|...|
xxx|...|
----...|
|......|
|......|
|......|
|...----
|...|xxx
|...|xxx
-----xxx`,
                    contents: (m) => { filler_region(5, 5); },
                });
            },
        },

        {
            name: 'Z-shaped, rot 1',
            contents: () => {
                des.map({
                    map: `--------xxx
|......|xxx
|......|xxx
|......----
----......|
xxx|......|
xxx|......|
xxx--------`,
                    contents: (m) => { filler_region(2, 2); },
                });
            },
        },

        {
            name: 'Cross',
            contents: () => {
                des.map({
                    map: `xxx-----xxx
xxx|...|xxx
xxx|...|xxx
----...----
|.........|
|.........|
|.........|
----...----
xxx|...|xxx
xxx|...|xxx
xxx-----xxx`,
                    contents: (m) => { filler_region(6, 6); },
                });
            },
        },

        {
            name: 'Four-leaf clover',
            contents: () => {
                des.map({
                    map: `-----x-----
|...|x|...|
|...---...|
|.........|
---.....---
xx|.....|xx
---.....---
|.........|
|...---...|
|...|x|...|
-----x-----`,
                    contents: (m) => { filler_region(6, 6); },
                });
            },
        },

        {
            name: 'Water-surrounded vault',
            contents: () => {
                des.map({
                    map: `}}}}}}
}----}
}|..|}
}|..|}
}----}
}}}}}}`,
                    contents: (m) => {
                        des.region({
                            region: [3, 3, 3, 3], type: 'themed', irregular: true,
                            filled: 0, joined: false,
                        });
                        const nasty_undead = luaList('giant zombie', 'ettin zombie', 'vampire lord');
                        const chest_spots = luaList([2, 2], [3, 2], [2, 3], [3, 3]);

                        shuffle(chest_spots);
                        // Guarantee an escape item inside one of the chests, to prevent
                        // the hero falling in from above and becoming permanently stuck
                        // [cf. generate_way_out_method(sp_lev.c)].
                        // If the escape item is made of glass or crystal, make sure that
                        // the chest isn't locked so that kicking it to gain access to its
                        // contents won't be necessary; otherwise retain lock state from
                        // random creation.
                        // "pick-axe", "dwarvish mattock" could be included in the list of
                        // escape items but don't normally generate in containers.
                        const escape_items = luaList(
                            'scroll of teleportation', 'ring of teleportation',
                            'wand of teleportation', 'wand of digging',
                        );
                        const itm = obj.new(escape_items[math.random(luaLen(escape_items))]);
                        const itmcls = obj.class(itm);
                        let box;
                        if (itmcls['material'] === 'glass') {
                            // explicitly force chest to be unlocked
                            box = des.object({
                                id: 'chest', coord: chest_spots[1],
                                olocked: 'no',
                            });
                        } else {
                            // accept random locked/unlocked state
                            box = des.object({ id: 'chest', coord: chest_spots[1] });
                        }
                        obj.addcontent(box, itm);

                        for (let i = 2; i <= luaLen(chest_spots); i++) {
                            des.object({ id: 'chest', coord: chest_spots[i] });
                        }

                        shuffle(nasty_undead);
                        des.monster(nasty_undead[1], 2, 2);
                        des.exclusion({ type: 'teleport', region: [2, 2, 3, 3] });
                    },
                });
            },
        },

        {
            name: 'Twin businesses',
            mindiff: 4, // arbitrary
            contents: () => {
                // Due to the way room connections work in mklev.c, we must guarantee
                // that the "aisle" between the shops touches all four walls of the
                // larger room. Thus it has an extra width and height.
                des.room({
                    type: 'themed',
                    w: 9,
                    h: 5,
                    contents: () => {
                        // There are eight possible placements of the two shops, four of
                        // which have the vertical aisle in the center.
                        const southeast = () => percent(50) && 'south' || 'east';
                        const northeast = () => percent(50) && 'north' || 'east';
                        const northwest = () => percent(50) && 'north' || 'west';
                        const southwest = () => percent(50) && 'south' || 'west';
                        const placements = luaList(
                            { lx: 1, ly: 1, rx: 4, ry: 1, lwall: 'south', rwall: southeast() },
                            { lx: 1, ly: 2, rx: 4, ry: 2, lwall: 'north', rwall: northeast() },
                            { lx: 1, ly: 1, rx: 5, ry: 1, lwall: southeast(), rwall: southwest() },
                            { lx: 1, ly: 1, rx: 5, ry: 2, lwall: southeast(), rwall: northwest() },
                            { lx: 1, ly: 2, rx: 5, ry: 1, lwall: northeast(), rwall: southwest() },
                            { lx: 1, ly: 2, rx: 5, ry: 2, lwall: northeast(), rwall: northwest() },
                            { lx: 2, ly: 1, rx: 5, ry: 1, lwall: southwest(), rwall: 'south' },
                            { lx: 2, ly: 2, rx: 5, ry: 2, lwall: northwest(), rwall: 'north' },
                        );
                        let ltype = 'weapon shop'; let rtype = 'armor shop';
                        if (percent(50)) {
                            [ltype, rtype] = [rtype, ltype];
                        }
                        const shopdoorstate = () => {
                            if (percent(1)) {
                                return 'locked';
                            } else if (percent(50)) {
                                return 'closed';
                            } else {
                                return 'open';
                            }
                        };
                        const p = placements[d(luaLen(placements))];
                        des.room({
                            type: ltype, x: p['lx'], y: p['ly'], w: 3, h: 3, filled: 1, joined: false,
                            contents: () => {
                                des.door({ state: shopdoorstate(), wall: p['lwall'] });
                            },
                        });
                        des.room({
                            type: rtype, x: p['rx'], y: p['ry'], w: 3, h: 3, filled: 1, joined: false,
                            contents: () => {
                                des.door({ state: shopdoorstate(), wall: p['rwall'] });
                            },
                        });
                    },
                });
            },
        },

    );

    // store these at global scope, they will be reinitialized in
    // pre_themerooms_generate
    let debug_rm_idx = null;
    let debug_fill_idx = null;

    // Given a point in a themed room, ensure that themed room is stocked with
    // regular room contents.
    // With 30% chance, also give it a random themed fill.
    function filler_region(x, y) {
        let rmtyp = 'ordinary';
        let func = null;
        if (percent(30)) {
            rmtyp = 'themed';
            func = themeroom_fill;
        }
        des.region({ region: [x, y, x, y], type: rmtyp, irregular: true, filled: 1, contents: func });
    }

    function is_eligible(room, mkrm) {
        // themerms.lua:891 `local t = type(room)`, which the .lua never reads.
        type(room);
        const diff = nh.level_difficulty();
        if (room.mindiff != null && diff < room.mindiff) {
            return false;
        } else if (room.maxdiff != null && diff > room.maxdiff) {
            return false;
        }
        if (mkrm != null && room.eligible != null) {
            return room.eligible(mkrm);
        }
        return true;
    }

    // given the name of a themed room or fill, return its index in that array
    function lookup_by_name(name, checkfills) {
        if (name == null) {
            return null;
        }
        if (checkfills) {
            for (let i = 1; i <= luaLen(themeroom_fills); i++) {
                if (themeroom_fills[i].name === name) {
                    return i;
                }
            }
        } else {
            for (let i = 1; i <= luaLen(themerooms); i++) {
                if (themerooms[i].name === name) {
                    return i;
                }
            }
        }
        return null;
    }

    // called repeatedly until the core decides there are enough rooms
    function themerooms_generate() {
        if (debug_rm_idx != null) {
            // room may not be suitable for stairs/portals, so create the "default"
            // room half of the time
            // (if the user specified BOTH a room and a fill, presumably they are
            // interested in what happens when that room gets that fill, so don't
            // bother generating default-with-fill rooms as happens below)
            let actualrm = lookup_by_name('default', false);
            if (percent(50)) {
                if (is_eligible(themerooms[debug_rm_idx])) {
                    actualrm = debug_rm_idx;
                } else {
                    pline(`Warning: themeroom '${themerooms[debug_rm_idx].name}' is ineligible`);
                }
            }
            themerooms[actualrm].contents();
            return;
        } else if (debug_fill_idx != null) {
            // when a fill is requested but not a room, still create the "default"
            // room half of the time, and "default with themed fill" half of the time
            // (themeroom_fill will take care of guaranteeing the fill in it)
            const actualrm = lookup_by_name(percent(50) && 'Default room with themed fill'
                || 'default');
            themerooms[actualrm].contents();
            return;
        }
        let pick = null;
        let total_frequency = 0;
        for (let i = 1; i <= luaLen(themerooms); i++) {
            if (type(themerooms[i]) !== 'table') {
                nh.impossible(`themed room ${i} is not a table`);
            } else if (is_eligible(themerooms[i], null)) {
                // Reservoir sampling: select one room from the set of eligible rooms,
                // which may change on different levels because of level difficulty.
                let this_frequency;
                if (themerooms[i].frequency != null) {
                    this_frequency = themerooms[i].frequency;
                } else {
                    this_frequency = 1;
                }
                total_frequency = total_frequency + this_frequency;
                // avoid rn2(0) if a room has freq 0
                if (this_frequency > 0 && nh.rn2(total_frequency) < this_frequency) {
                    pick = i;
                }
            }
        }
        if (pick == null) {
            nh.impossible('no eligible themed rooms?');
            return;
        }
        themerooms[pick].contents();
    }

    // called before any rooms are generated
    function pre_themerooms_generate() {
        const debug_themerm = nh.debug_themerm(false);
        const debug_fill = nh.debug_themerm(true);
        let xtrainfo = '';
        debug_rm_idx = lookup_by_name(debug_themerm, false);
        debug_fill_idx = lookup_by_name(debug_fill, true);
        if (debug_themerm != null && debug_rm_idx == null) {
            if (lookup_by_name(debug_themerm, true) != null) {
                xtrainfo = '; it is a fill type';
            }
            pline(`Warning: themeroom '${debug_themerm}' not found in themerooms${xtrainfo}`, true);
        }
        if (debug_fill != null && debug_fill_idx == null) {
            if (lookup_by_name(debug_fill, false) != null) {
                xtrainfo = '; it is a room type';
            }
            pline(`Warning: themeroom fill '${debug_fill}' not found in themeroom_fills${xtrainfo}`, true);
        }
    }

    // called after all rooms have been generated
    // but before creating connecting corridors/doors, or filling rooms
    function post_themerooms_generate() {
    }

    function themeroom_fill(rm) {
        if (debug_fill_idx != null) {
            if (is_eligible(themeroom_fills[debug_fill_idx], rm)) {
                themeroom_fills[debug_fill_idx].contents(rm);
            } else {
                // ideally this would be a debugpline, not a full pline, and offer
                // some more context on whether it failed because of difficulty or
                // because of eligible function returning false; the warning doesn't
                // necessarily mean anything.
                pline(`Warning: fill '${themeroom_fills[debug_fill_idx].name}' is not eligible in room that generated it`);
            }
            return;
        }
        let pick = null;
        let total_frequency = 0;
        for (let i = 1; i <= luaLen(themeroom_fills); i++) {
            if (type(themeroom_fills[i]) !== 'table') {
                nh.impossible(`themeroom fill ${i} must be a table`);
            } else if (is_eligible(themeroom_fills[i], rm)) {
                // Reservoir sampling: select one room from the set of eligible rooms,
                // which may change on different levels because of level difficulty.
                let this_frequency;
                if (themeroom_fills[i].frequency != null) {
                    this_frequency = themeroom_fills[i].frequency;
                } else {
                    this_frequency = 1;
                }
                total_frequency = total_frequency + this_frequency;
                // avoid rn2(0) if a fill has freq 0
                if (this_frequency > 0 && nh.rn2(total_frequency) < this_frequency) {
                    pick = i;
                }
            }
        }
        if (pick == null) {
            nh.impossible('no eligible themed room fills?');
            return;
        }
        themeroom_fills[pick].contents(rm);
    }

    // postprocess callback: create an engraving pointing at a location
    function make_dig_engraving(data) {
        const floors = selection.filter_mapchar(selection.negate(), '.');
        const pos = selection.rndcoord(floors, 0);
        const tx = data.x - pos.x - 1;
        const ty = data.y - pos.y;
        let dig = '';
        if (tx === 0 && ty === 0) {
            dig = ' here';
        } else {
            if (tx < 0 || tx > 0) {
                dig = string.format(' %i %s', math.abs(tx), (tx > 0) && 'east' || 'west');
            }
            if (ty < 0 || ty > 0) {
                dig = dig + string.format(' %i %s', math.abs(ty), (ty > 0) && 'south' || 'north');
            }
        }
        des.engraving({ coord: pos, type: 'burn', text: 'Dig' + dig });
    }

    // postprocess callback: turn room walls into trees
    function make_garden_walls(data) {
        const sel = selection.grow(data.sel);
        // change walls to trees
        des.replace_terrain({ selection: sel, fromterrain: 'w', toterrain: 'T' });
        // update secret doors; attempting to change to AIR will set arboreal flag
        des.replace_terrain({ selection: sel, fromterrain: 'S', toterrain: 'A' });
    }

    // postprocess callback: make a trap
    function make_a_trap(data) {
        if (data.teledest === 1 && data.type === 'teleport') {
            const locs = selection.filter_mapchar(selection.negate(), '.');
            do {
                data.teledest = selection.rndcoord(locs, 1);
            } while (!(data.teledest.x !== data.coord.x && data.teledest.y !== data.coord.y));
        }
        des.trap(data);
    }

    // called once after the whole level has been generated
    function post_level_generate() {
        for (const v of postprocess) {
            v.handler(v.data);
        }
        postprocess = [];
    }

    return {
        themeroom_fills,
        themerooms,
        filler_region,
        is_eligible,
        lookup_by_name,
        themerooms_generate,
        pre_themerooms_generate,
        post_themerooms_generate,
        themeroom_fill,
        make_dig_engraving,
        make_garden_walls,
        make_a_trap,
        post_level_generate,
    };
}
