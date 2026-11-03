#!/usr/bin/env python3
"""gen-fuzz.py - monkey-test session *recipes* for scripts/record-session.mjs.

Usage: gen-fuzz.py <outdir> <count> <first-seed> <actions-per-session> [wiz|play]

wiz  (default) playmode:debug: wishes, ^G monsters, #polyself, traps from
     wishes - dense coverage of rare code (blog topics: digging, scare
     monster/Elbereth, trap doors while polymorphed, horns, floating eyes,
     riding, deaths while helpless).
play normal game: no wizard commands, so deaths reach the tombstone and
     top-ten screens that debug mode skips.

Each action ends with ' ' + ESC so --More-- and prompts never wedge the run.
Datetimes stay at 07:00-20:00 local: the recorder's mktime() inherits DST
from the machine's *real* clock (see docs/NOTES-recording-environment.md),
so a probe recorded in winter near midnight/06:00/22:00 diverges from the
port's fixed -04:00 for reasons that are not port bugs.

Record SERIALLY: debug mode forces the name "wizard" and every run shares one
nethackdir, so concurrent recordings collide on lock files.
"""
import json, os, sys, random
OUT, N, START, NACT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
MODE = sys.argv[5] if len(sys.argv) > 5 else 'wiz'

W='\x17'; G='\x07'; ESC='\x1b'
ROLES=[('Archeologist','dwarf','lawful'),('Barbarian','orc','chaotic'),('Caveman','gnome','neutral'),('Healer','gnome','neutral'),('Knight','human','lawful'),('Monk','human','neutral'),('Priest','elf','chaotic'),('Ranger','elf','chaotic'),('Rogue','orc','chaotic'),('Samurai','human','lawful'),('Tourist','human','neutral'),('Valkyrie','dwarf','lawful'),('Wizard','elf','chaotic')]
ITEMS=['pick-axe','wand of digging','scroll of scare monster','frost horn','fire horn','tinning kit','potion of blindness','amulet of magical breathing','cream pie','wand of striking','wand of sleep','wand of cold','wand of fire','wand of polymorph','wand of teleportation','wand of create monster','scroll of teleportation','scroll of genocide','potion of levitation','ring of levitation','ring of free action','saddle','leash','bag of holding','magic whistle','tin whistle','drum of earthquake','bugle','magic marker','scroll of fire','potion of oil','oil lamp','stethoscope','unicorn horn','crystal ball','figurine','egg','tin','lizard corpse','cockatrice corpse','Medusa corpse','blindfold','towel','land mine','beartrap','spear','dagger','boomerang','10 arrows','bow','crossbow','5 darts','boulder','trap door','hole','fire trap','sleeping gas trap','magic trap','polymorph trap','teleportation trap','level teleporter','rust trap','web','statue trap','squeaky board','rolling boulder trap','anti-magic field','fountain','sink','altar','throne','grave','tree','iron bars','spellbook of sleep','spellbook of dig','potion of polymorph','scroll of earth','scroll of create monster','gauntlets of power','speed boots','elven cloak','helm of brilliance','Excalibur','Magicbane','Mjollnir']
MONS=['Cyclops','minotaur','vampire lord','dwarf','soldier ant','floating eye','jackal','red naga','fire ant','gnome lord','human zombie','vampire','nymph','leprechaun','cockatrice','umber hulk','xorn','purple worm','gelatinous cube','shopkeeper','watchman','unicorn','pony','horse','warhorse','dog','kitten','mind flayer','lich','titan','ettin','mastodon','hill giant','rust monster','disenchanter','green slime','energy vortex','dust vortex','giant eel','water moccasin','orc shaman','kobold','newt','grid bug','yellow light','black light','chameleon','doppelganger','quantum mechanic','tengu','owlbear','succubus','incubus','water nymph','wraith','ghost','Medusa','Croesus','Oracle','priest','aligned priest','soldier','sergeant']
POLY=['mastodon','ettin','hill giant','titan','xorn','vampire lord','bat','umber hulk','floating eye','cockatrice','nymph','purple worm','iron golem','red dragon','minotaur','gnome','pony','eel','tengu','mind flayer']
D='hjklyubn'
def act(r, inv):
    k=r.random()
    L=lambda: r.choice(inv)
    d=lambda: r.choice(D+'<>.')
    if k<0.30: a = (str(r.randint(2,9)) if r.random()<0.3 else '') + r.choice(D)
    elif k<0.36: a = 'F'+r.choice(D)
    elif k<0.40: a = str(r.randint(2,20))+'s'
    elif MODE == 'play' and k<0.57: a = r.choice(['s', '20s', ':', 'i', '\x18', '>', '<', ',', 'Fh', 'Fl'])
    elif k<0.47: a = W + r.choice(ITEMS) + '\n'
    elif k<0.54: a = G + r.choice(MONS) + '\n'
    elif k<0.57: a = '#polyself\n' + r.choice(POLY) + '\n'
    elif k<0.62: a = 'a' + L() + d() + r.choice('yn')
    elif k<0.66: a = 'z' + L() + d()
    elif k<0.69: a = 't' + L() + d()
    elif k<0.71: a = 'q' + L()
    elif k<0.73: a = 'r' + L()
    elif k<0.75: a = 'e' + L() + 'y'
    elif k<0.77: a = 'W' + L()
    elif k<0.79: a = 'P' + L()
    elif k<0.81: a = 'w' + L()
    elif k<0.83: a = 'E-Elbereth\n'
    elif k<0.85: a = r.choice(['>','<','#sit\n','#pray\ny','#ride\n'+r.choice(D)+'y','#chat\n'+r.choice(D),'#kick\n'+r.choice(D),'#force\n','#jump\n','#untrap\n'+r.choice(D),'#turn\n','#monster\n','#dip\n'+L()+'n'+L()])
    elif k<0.87: a = ',' + 'a'
    elif k<0.89: a = 'd' + L()
    elif k<0.91 and MODE == 'wiz': a = '\x14'
    elif k<0.92 and MODE == 'wiz': a = '\x16' + str(r.randint(1,30)) + '\n'
    elif k<0.94: a = 'Z' + 'a' + r.choice(D)
    elif k<0.96: a = 'o' + r.choice(D)
    elif k<0.98: a = '#loot\ny'
    else: a = 'x'
    return a + ' ' + ESC
os.makedirs(OUT, exist_ok=True)
for i in range(N):
    seed = START + i; r = random.Random(seed)
    role, race, align = ROLES[i % len(ROLES)]
    rc = (f'OPTIONS=name:Fuzz,role:{role},race:{race},gender:{'female' if role=='Valkyrie' or i%2 else 'male'},align:{align}' + (',playmode:debug' if MODE == 'wiz' else '') + '\n'
          'OPTIONS=!autopickup,!legacy,!tutorial,suppress_alert:3.4.3\n')
    inv = list('abcdefghijklmnopqrstuvwxyz')[:20]
    moves = ''.join(act(r, inv) for _ in range(NACT))
    d={'version':5,'segments':[{'seed':seed,'datetime':'2026%02d%02d%02d%02d00'%(r.randint(1,12),r.randint(1,28),r.randint(7,20),r.randint(0,59)),'nethackrc':rc,'moves':moves}],'source':'c'}
    json.dump(d, open(f'{OUT}/fz{seed}-{"wizfuzz" if MODE == "wiz" else "playfuzz"}-{role.lower()}.session.json','w'))
