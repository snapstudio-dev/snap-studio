# Contribuer à Snap Studio

[English](CONTRIBUTING.md) · **Français**

Merci de votre intérêt ! Snap Studio avance grâce à ce que ses utilisateurs
signalent : bugs, besoins, imprimantes qui se comportent bizarrement. Toute
contribution aide, code ou non.

## Signaler un bug

Depuis l'app : **Réglages → À propos → Signaler un bug** (ou **Aide →
Signaler un bug…**). Le formulaire s'ouvre sur GitHub avec la version et le
système déjà remplis. Sinon : [nouvelle issue](https://github.com/kameka22/snap-studio/issues/new/choose).

Avant, jetez un œil aux [issues ouvertes](https://github.com/kameka22/snap-studio/issues) :
le problème est peut-être connu. Un bon signalement dit :

- ce que vous avez fait, ce qui s'est passé, ce que vous attendiez ;
- les étapes pour le reproduire, si possible ;
- le fichier 3MF quand un modèle est en cause (joignez-le, ou un plus petit
  qui montre le même problème) ;
- l'imprimante et son firmware quand l'impression est en cause.

## Proposer une idée

**Réglages → À propos → Proposer une idée**, ou [nouvelle issue](https://github.com/kameka22/snap-studio/issues/new?template=feature.yml).
Décrivez le besoin — ce que vous cherchez à faire et ce qui gêne — plutôt
que la solution : il en existe souvent une plus simple. Pour les questions
et les idées à discuter, il y a les [Discussions](https://github.com/kameka22/snap-studio/discussions).

## Contribuer au code

1. **Compiler** : Rust (stable) et la CLI Tauri, puis `cargo tauri dev`.
   L'interface est en HTML/CSS/JavaScript simples dans `ui/`, sans npm.
2. **Tester** : `cd src-tauri && cargo test --lib`, et la logique de
   l'interface avec `for t in scripts/test-*.js; do node "$t"; done`. Certains tests
   demandent le moteur de découpe ou un vrai Claude Code et sont facultatifs
   (`--ignored`, voir leurs commentaires).
3. **Écrire en anglais** : code, commentaires, commits et documentation. Les
   textes de l'interface vont dans `ui/i18n/en.json` et `ui/i18n/fr.json`
   (jamais en dur) ; `python3 scripts/check-i18n.py` les vérifie.
4. **Suivre le code autour** : ses noms, sa densité de commentaires, ses
   habitudes. L'organisation est décrite dans [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#layout) (en anglais).
5. **Un sujet par pull request**, avec ce qu'elle change et comment elle a
   été vérifiée. Pour un changement plus large, ouvrez d'abord une issue ou
   une discussion ; le travail en cours vit dans [`docs/plans/`](docs/plans/).
6. **Changelog** : un changement visible pour l'utilisateur ajoute une ligne
   sous *Unreleased* dans [CHANGELOG.md](CHANGELOG.md) (en anglais), avec le
   numéro de sa pull request.

## Traduire Snap Studio

L'anglais est la référence ; le français, l'allemand, l'espagnol, le
portugais du Brésil, l'italien, le japonais, le chinois simplifié et le
coréen sont des traductions. Chaque langue est un fichier,
`ui/i18n/<langue>.json`, avec les mêmes clés que `ui/i18n/en.json` ; une clé
manquante s'affiche en anglais. Gardez les `{paramètres}`, les balises HTML et
les formes du pluriel (`one`, `other`… ; le japonais, le chinois et le coréen
n'ont que `other`), et les mots de la communauté des trancheurs (les traductions d'OrcaSlicer sont un bon guide). Avant une
pull request, lancez `python3 scripts/check-i18n.py` : il vérifie tous les
catalogues et indique où en est chacun. Une relecture dans
[Weblate](https://weblate.org/) est prévue ; d'ici là, une pull request sur
le catalogue fait l'affaire. Ajouter une langue est décrit dans
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#languages) (en anglais).

## Sécurité

Un problème de sécurité se signale en privé, pas dans une issue : voir
[SECURITY.md](SECURITY.md) (en anglais).

## Code de conduite

Toute participation — issues, discussions, pull requests — suit le
[code de conduite](CODE_OF_CONDUCT.md) (en anglais) : respect, bienveillance,
critiques constructives.

## Licence

Snap Studio est un logiciel libre sous [GNU GPL v3](LICENSE) ou ultérieure.
En contribuant, vous acceptez que votre contribution soit distribuée sous la
même licence.
