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
 'coyote': G('coyote') + G('coyote') + ';m.' + E + ';mm.' + E + 's' + ';m.' + E,
 'shade': G('shade') + F8 + W('silver saber') + 'we' + E + F8 + F8,
 'flute': '#levelchange\n30\n' + E + W('wooden flute') + G('snake') + G('snake') + G('water moccasin') + ('ae' + 'y' + E) * 4 + 's' * 3,
 'palantir': W('Palantir of Westernesse') + G('jackal') + G('jackal') + '#invoke\ne' + E + 's' + W('Platinum Yendorian Express Card') + '#invoke\nf' + 'e' + E + E,
 'masterkey': W('Master Key of Thievery') + 'we' + E + W('bear trap') + 'l' + E + 'h' + E + W('magic trap') + 'll' + E + 'hh' + E + 's' * 4,
 'jelly': W('3 lumps of royal jelly') + 'de' + E + G('killer bee') + G('queen bee') + 's' * 12,
 'polypile': W('wand of polymorph') + W('50 daggers') + 'df' + E + 'ze>' + E + W('40 arrows') + 'dg' + E + 'ze>' + E + ':' + E,
 'touchstone': W('touchstone') + W('worthless piece of blue glass') + '#rub\nef' + E + W('ruby') + '#rub\neg' + E,
 'alreadynamed': G('jackal') + '#name\nm' + 'm.' + 'Rex\n' + E + '#name\nm' + 'm.' + 'Rex\n' + E + 'C' + 'm.' + 'Rex\n' + E,
 'mimic': G('giant mimic') + W('wand of striking') + ''.join('ze' + d + E for d in 'hjklyubn') + W('wand of opening') + ''.join('zf' + d + E for d in 'hjkl'),
 'confusemon': W('scroll of confuse monster') + 're' + E + G('jackal') + F8 + 's' * 3 + F8,
 'gascloud': W('scroll of stinking cloud') + 're' + '.' + E + '#pray\ny' + E + E + E,
 'twoweapon': W('silver saber') + 'xe' + E + 'we' + E + 'x' + E + '#twoweapon\n' + E + G('soldier ant') + F8 + 'de' + E,
}
n = 0
for name, mv in sc.items():
    for k in range(3):
        d = {'version': 5, 'segments': [{'seed': 900 + 10 * n + k, 'datetime': '20260715120000', 'nethackrc': rc, 'moves': pre + mv + tail}]}
        json.dump(d, open(f'{out}/feat-{name}-{k}.session.json', 'w'))
    n += 1
print(n * 3)
