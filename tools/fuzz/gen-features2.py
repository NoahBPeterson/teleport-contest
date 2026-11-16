import json, sys
out = sys.argv[1]
rc = "OPTIONS=name:wizard,role:Valkyrie,race:human,gender:female,align:neutral\nOPTIONS=playmode:debug\nOPTIONS=!autopickup,pettype:none\n"
E = '\x1b\x1b'
W = lambda item: '#wizwish\n' + item + '\n' + E
G = lambda mon: '\x07' + mon + '\n' + E
F8 = ''.join('F' + d + E for d in 'hjklyubn')
tail = 'i\x1b+\x1b\\\x1b\x18 \x1bss:'
pre = '\x1b\x1b\x1b'
sc = {
 'palantir2': W('The Palantir of Westernesse') + G('jackal') + G('jackal') + G('jackal') + '#invoke\ne' + E + 's' + '#invoke\ne' + E,
 'card2': W('The Platinum Yendorian Express Card') + W('wand of striking') + '#invoke\ne' + 'f' + E + E + '#invoke\ne' + 'f' + E,
 'masterkey2': W('The Master Key of Thievery') + 'we' + E + W('bear trap') + 'l' + E + 'h' + E + W('magic trap') + 'll' + E + 'hh' + E + 's' * 4 + 'jj' + E + 'kk' + E,
 'jelly2': W('3 lumps of royal jelly') + 'de' + E + G('killer bee') + G('queen bee') + G('killer bee') + 's' * 40,
 'polypile2': W('wand of polymorph') + W('50 daggers') + 'db' + E + 'ze>' + E + ':' + E + W('40 arrows') + 'df' + E + 'ze>' + E + ':' + E + W('30 rocks') + 'dg' + E + 'ze>' + E,
 'touchstone2': W('touchstone') + W('worthless piece of blue glass') + '#rub\n' + 'e' + 'f' + E + E + 'ae' + E + E,
 'named2': G('jackal') + '#name\n' + 'm' + '  ' + 'm.' + 'Rex\n' + E + '#name\n' + 'm' + '  ' + 'm.' + 'Rex\n' + E + '#name\n' + 'm' + '  ' + 'm.' + 'Spot\n' + E,
 'confusemon2': W('scroll of confuse monster') + 're' + E + G('jackal') + G('jackal') + G('jackal') + G('jackal') + F8 + F8 + F8,
}
n = 0
for name, mv in sc.items():
    for k in range(3):
        d = {'version': 5, 'segments': [{'seed': 1300 + 10 * n + k, 'datetime': '20260715120000', 'nethackrc': rc, 'moves': pre + mv + tail}]}
        json.dump(d, open(f'{out}/feat-{name}-{k}.session.json', 'w'))
    n += 1
print(n * 3)
