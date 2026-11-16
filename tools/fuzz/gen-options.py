import json, re, sys, os
up, sess_dir, out = sys.argv[1:4]
src = open(f'{up}/include/optlist.h').read()
bools = []
for m in re.finditer(r'NHOPTB\(\s*(\w+)\s*,\s*\w+\s*,\s*\d+\s*,\s*\w+\s*,\s*(\w+)\s*,\s*(On|Off)', src):
    name, where, dflt = m.groups()
    if where in ('set_in_config', 'set_in_game'): bools.append(('!' if dflt == 'On' else '') + name)
bools = sorted(set(bools))
comp = ['symset:DECgraphics', 'symset:curses', 'symset:Enhanced1', 'roguesymset:RogueEpyx', 'runmode:walk', 'runmode:crawl', 'runmode:teleport',
        'msg_window:full', 'msg_window:reversed', 'msg_window:combination', 'number_pad:1', 'number_pad:2', 'number_pad:-1',
        'pile_limit:0', 'pile_limit:1', 'menustyle:traditional', 'menustyle:combination', 'menustyle:partial',
        'menu_headings:bold', 'menu_headings:underline', 'sortloot:l', 'sortloot:n', 'fruit:kumquat', 'pickup_types:$?!/="+',
        'pickup_burden:unencumbered', 'boulder:0', 'paranoid_confirmation:quit pray attack wand-break Were-change eat',
        'autounlock:untrap+apply-key+kick', 'whatis_coord:compass', 'whatis_coord:map', 'whatis_coord:screen',
        'whatis_filter:area', 'msghistory:5', 'petattr:inverse', 'packorder:")[%?+!=/(*`0_', 'sortdiscoveries:a', 'sortdiscoveries:s',
        'statushilites:3', 'hilite_status:hitpoints/<50%/red/30%/red&inverse', 'hilite_status:gold/up/green/down/red',
        'hilite_status:characteristics/up/green/down/red', 'hilite_status:condition/all/orange', 'hilite_status:title/always/blue',
        'hilite_status:experience-level/changed/yellow', 'menucolor:"blessed"=green', 'menucolor:" cursed"=red&bold',
        'menu_select_all:.', 'scores:5 top/2 around/own', 'disclose:+i +a +v +g +c +o', 'mention_walls', 'mention_decor',
        'hitpointbar', 'showexp', 'showscore', 'time', 'color', 'lit_corridor', 'dark_room', 'standout', 'implicit_uncursed',
        'statuslines:3', 'windowborders:0', 'altmeta', 'sparkle', 'travel', 'verbose', 'autodescribe', 'autoquiver', 'force_invmenu',
        'perm_invent', 'perminv_mode:all', 'menu_overlay', 'menuinvertmode:1', 'catname:Tom', 'dogname:Rex', 'horsename:Ed',
        'pettype:cat', 'pettype:dog', 'gender:female', 'suppress_alert:3.4.3', 'mouse_support:0', 'tips', 'versinfo:3', 'crash_email:x']
opts = list(dict.fromkeys(bools + comp))
bases = ['seed0106-priest-extcmd-sweep', 'seed0108-wizard-extcmd-wishlist', 'seed0383-wizard-hallucinate', 'seed2200-wizard-quaff-zap-read', 'seed0012-monk-vault-escort', 'seed0030-ten-diverse-deaths']
n = 0
for b in bases:
    d = json.load(open(f'{sess_dir}/{b}.session.json'))
    for o in opts:
        segs = [{'seed': s['seed'], 'datetime': s['datetime'], 'nethackrc': s['nethackrc'].rstrip('\n') + '\nOPTIONS=' + o + '\n', 'moves': s['moves']} for s in d['segments']]
        tag = re.sub(r'[^A-Za-z0-9]+', '_', o)[:40]
        json.dump({'version': 5, 'segments': segs}, open(f'{out}/{b[:8]}--{tag}.session.json', 'w')); n += 1
print(len(bools), 'bools', len(opts), 'opts', n, 'sessions')
