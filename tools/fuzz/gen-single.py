import json, random, sys
out, N, L = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
roles = ['Archeologist','Barbarian','Caveman','Healer','Knight','Monk','Priest','Rogue','Ranger','Samurai','Tourist','Valkyrie','Wizard']
dates = ['20260715120000','20260713230000','20261113120000','20260227030000','20260101000000','20261231235959','20260802120000','20260617220000']
moves = list('hjklyubn') * 6 + list('HJKLYUBN') + list('s.') * 3
cmds = ['i\x1b', ',', ',\x1b', '>', '<', 'e', 'q', 'r', 'z', 'a', 't', 'f', 'w', 'W', 'T', 'P', 'R', 'Q', 'd', 'D', 'x', 'E-', 'o', 'c', '#pray\n', '#chat\n', '#sit\n', '#loot\n', '#force\n', '#offer\n', '#turn\n', '#enhance\n', '#dip\n', '^', ':', ';', 'C', '\x04', '\x14', '_<', '_>', '\\', '+', '\x18', 'O\x1b', 'S\x1b', '20s', 'n20s', '#terrain\n', '#overview\n', '\x10']
wiz = ['\x16%d\n' % d for d in range(2, 30)] + ['\x06', '\x07jackal\n', '\x07random\n', '\x07\n', '#wizwish\nwand of digging\n', '#wizwish\nblessed scroll of genocide\n', '#wizwish\nring of conflict\n', '#wizwish\nmagic marker\n', '#wizwish\n2 cursed potions of gain level\n', '#wizwish\nbag of holding\n', '#wizwish\nexpensive camera\n', '#wizwish\nwand of create monster\n', '#wizwish\namulet of life saving\n', '#wizwish\nfrost horn\n', '#levelchange\n14\n', '\x05', '\x09', '#wizintrinsic\n']
answers = list('yn \x1b\x1b\r') + list('abcdefghijklmnopqrstuvwxyz') + list('hjkl.<>*-?$')
for i in range(N):
    rnd = random.Random(5000 + i)
    w = i % 2 == 0
    role = rnd.choice(roles)
    rc = 'OPTIONS=name:%s,role:%s,race:random,gender:random,align:random\nOPTIONS=!tutorial,!legacy,!splash_screen\n' % ('wizard' if w else 'fuzz', role) + ('OPTIONS=playmode:debug\n' if w else '') + rnd.choice(['', 'OPTIONS=color,DECgraphics\n', 'OPTIONS=time,showexp\n', 'OPTIONS=!autopickup\n', 'OPTIONS=number_pad:0,hilite_pet\n'])
    mv = '\x1b\x1b\x1b'
    while len(mv) < L:
        x = rnd.random()
        if x < 0.55: mv += rnd.choice(moves)
        elif x < 0.85: mv += rnd.choice(cmds) + ''.join(rnd.choice(answers) for _ in range(rnd.randint(0, 3)))
        elif x < 0.92 and w: mv += rnd.choice(wiz) + '\x1b'
        else: mv += rnd.choice(answers)
    mv += 'i\x1b+\x1b\\\x1b\x18 \x1bss:'
    d = {'version': 5, 'segments': [{'seed': 7000 + i, 'datetime': rnd.choice(dates), 'nethackrc': rc, 'moves': mv}]}
    json.dump(d, open(f'{out}/fuzz-{i:03d}.session.json', 'w'))
print(N)
