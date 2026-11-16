import json, random, sys
out, N = sys.argv[1], int(sys.argv[2])
moves = list('hjklyubn') * 6 + list('HJKLYUBN') + list('s.') * 3
cmds = ['i\x1b', '>', '<', 'e', 'q', 'r', 'a', 't', 'w', 'W', 'T', 'P', 'R', 'd', 'x', 'o', 'c', '#pray\n', '#chat\n', '#sit\n', '#loot\n', ':', ';', '\x04', '_<', '_>', '\\', '\x18', '20s', '\x06', '\x07random\n']
answers = list('yn \x1b\x1b\r') + list('abcdh') + list('hjkl.')
dates = ['20260715120000','20260713230000','20261113120000','20260227030000','20260617220000']
for i in range(N):
    rnd = random.Random(11000 + i)
    dl = rnd.randint(2, 12)
    rc = 'OPTIONS=name:wizard,role:Valkyrie,race:human,gender:female,align:neutral\nOPTIONS=!tutorial,!legacy,!splash_screen,!autopickup,pettype:none\nOPTIONS=playmode:debug\n'
    def rand(n):
        s = ''
        while len(s) < n:
            x = rnd.random()
            s += rnd.choice(moves) if x < 0.6 else (rnd.choice(cmds) + ''.join(rnd.choice(answers) for _ in range(rnd.randint(0, 2))) if x < 0.9 else rnd.choice(answers))
        return s
    die = '\x1b\x1b\x1b#wizwish\nwand of death\n\x1b\x1bze.' + '  ' + 'y' + 'nnnn' + 'y' + ('\x1b \n' * 12)
    segs = []
    nseg = rnd.randint(2, 4)
    for k in range(nseg):
        mv = '\x1b\x1b\x1b' + '\x16%d\n' % dl + 'y\x1b\x1b' + rand(rnd.randint(150, 400))
        mv += die if k < nseg - 1 else 'i\x1b\x18 \x1bss:'
        segs.append({'seed': 11000 + 13 * i + k, 'datetime': rnd.choice(dates), 'nethackrc': rc, 'moves': mv})
    json.dump({'version': 5, 'segments': segs}, open(f'{out}/fz3-{i:03d}.session.json', 'w'))
print(N)
