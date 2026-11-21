#!/bin/bash
# sweep.sh: lua-oracle forced level generation for every ported level script, every role
cd "$(dirname "$0")/../.." && mkdir -p .cache/oracle
LV=$(node -e "import('./js/lua-js/registry.mjs').then(m=>console.log(m.portedScripts().filter(s=>!['dungeon.lua','quest.lua','nhlib.lua','nhcore.lua','themerms.lua'].includes(s)).join(',')))")
O=.cache/oracle/sweep2.out; : > $O
ROLES="Archeologist:dwarf:female:lawful Barbarian:orc:male:chaotic Caveman:gnome:male:neutral Healer:gnome:female:neutral Knight:human:male:lawful Monk:human:female:neutral Priest:elf:male:chaotic Rogue:orc:female:chaotic Ranger:elf:male:chaotic Samurai:human:female:lawful Tourist:human:male:neutral Valkyrie:dwarf:female:lawful Wizard:gnome:male:neutral"
for seed in 8000 31337; do for r in $ROLES; do IFS=: read role race gen al <<< "$r"
  rc="OPTIONS=name:Ora,role:$role,race:$race,gender:$gen,align:$al,playmode:debug,!tutorial"
  echo "### $seed $role" >> $O
  nice -n 15 node --max-old-space-size=8192 tools/lua-oracle.mjs --levels=$LV --seed $seed --rc "$rc" --moves '  ' </dev/null >> $O 2>&1
done; done
echo "DONE" >> $O
rg -c '^PASS' $O; rg -c '^FAIL' $O; rg -n 'FAIL |^FAIL|Error|error' $O | head -40
