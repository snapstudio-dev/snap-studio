#!/bin/sh
# Screenshots of the mockup with headless Chrome, 1440 × 900.
cd "$(dirname "$0")"
shot() { google-chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1440,900 --virtual-time-budget=2000 --screenshot="$1" "file://$PWD/index.html?$2&shot=1" 2>/dev/null; }
for t in light dark; do
  shot "proposal-c-running-$t-fr.png" "p=c&v=running&theme=$t"
  shot "proposal-c-finished-$t-fr.png" "p=c&v=finished&theme=$t"
  for p in a b; do for v in overview detail; do shot "proposal-$p-$v-$t-fr.png" "p=$p&v=$v&theme=$t"; done; done
  shot "proposal-d-overview-$t-fr.png" "p=d&v=overview&theme=$t"
  shot "proposal-d-detail-running-$t-fr.png" "p=d&v=detail&theme=$t"
  shot "proposal-d-detail-finished-$t-fr.png" "p=d&v=finished&theme=$t"
done
