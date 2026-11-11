# Couleurs par hauteur (HueForge), étape 3 : plus de 4 couleurs et plan de bobines

Cette étape gère le cas où un modèle HueForge demande **plus de 4 couleurs** que les 4 têtes de la U1. Snap Studio calcule un plan de bobines, insère les pauses au bon endroit, et guide l'utilisateur dans Impressions au moment de recharger.

Analyse complète : [docs/hueforge/analyse.md](../hueforge/analyse.md), notamment §1.9 (limites U1), §2 (jobs, contrôle, `AUTO_FEEDING`), §4 proposition A points 4 à 6 et §5. Maquettes : `docs/hueforge/mockups/` (écrans 4a et 4b).

**Dépend de l'étape 2** (mode « Par hauteur » et import HueForge). Le socle moteur et les pauses `M600` viennent de l'étape 1.

## Objectif

Permettre d'imprimer un HueForge de plus de 4 couleurs en prévoyant automatiquement les rechargements, avec une carte claire dans Impressions au moment de la pause, sans que l'utilisateur place les pauses à la main.

## Prérequis sur une vraie U1 (bloquants)

Ces deux essais doivent être faits **avant d'implémenter l'échange guidé**, et de préférence avant de livrer cette étape. Ils sont déjà listés dans l'analyse (§5) :

1. **Qualité sans tour de purge** : un HueForge 4 couleurs (environ 100 × 100 mm, couches 0,08 / 0,16, remplissage 100 %), avec et sans tour, pour comparer le suintement des têtes en attente à 70 °C, la pré-extrusion, l'alignement et le temps réel par rapport à l'estimation.
2. **Pause `M600`, échange de bobine et reprise** : un essai 6 couleurs, pour vérifier le parcage, l'échange (d'abord par l'écran de la U1), la reprise, et l'absence de décalage de couche. Noter aussi l'effet de `pl_allow_save_env` après un `M600` (sauvegarde de reprise après coupure coupée, comportement exact non vérifié).

Un troisième point conditionne **seulement** l'échange guidé depuis Snap Studio :

3. Comportement de `AUTO_FEEDING` **pendant une pause**. Aujourd'hui, charger ou décharger une bobine est refusé en impression ou en pause (`control.rs:388-418`). Ce garde-fou ne doit pas être assoupli tant que l'essai U1 n'a pas montré que c'est sûr.

Tant que (3) n'est pas validé, la carte d'Impressions peut indiquer quoi charger et proposer **Reprendre**, mais l'app ne lance pas elle-même l'échange.

## Périmètre

### Plan de bobines

- Calcul automatique à partir des changements du mode « Par hauteur » et des bobines réellement chargées.
- Les 4 premières couleurs vont sur les têtes qui ont déjà la bonne bobine, d'après la couleur ΔE de `spoolcheck.js`.
- Au-delà, Snap Studio ajoute lui-même une **pause une couche avant** le prochain changement qui exige une couleur non chargée (comme le module « 3MF Export » de HueForge), et choisit quelle tête recharger : une tête qui ne resservira plus, si possible.
- Option **« Regrouper les rechargements »** : rassembler plusieurs échanges dans une seule pause (maquette 4a : 6 couleurs, une pause à la couche 8 · 0,72 mm pour charger le jaune sur T0 et le blanc sur T1, au lieu de deux pauses).
- La feuille de découpe résume le plan, par exemple : « 6 couleurs : 4 automatiques, 1 pause à 0,72 mm pour charger Jaune sur T0 et Blanc sur T1. »
- Lors d'un départ depuis la file, la vérification des bobines contrôle les têtes du départ **et** rappelle les recharges prévues.

### Stockage du plan dans le job

- Le plan est recopié dans le job (`jobs.rs`) au moment de l'envoi, pour distinguer une pause **prévue** d'une pause manuelle.
- Format à figer à l'implémentation : liste des pauses avec hauteur / couche, et pour chacune les bobines à charger (couleur, matière, tête).
- Un éventuel `snapstudio_colors.json` dans le 3MF peut conserver la note et le plan, en plus du XML déjà écrit à l'étape 1.

### Carte dans Impressions

- Quand la pause en cours est prévue, Prints affiche une carte « Chargez *n* bobines » (maquette 4b) : pour chaque échange, la bobine demandée et la tête, l'état fait / en attente, et le bouton **Reprendre**.
- Le message de pause n'est jamais écrit dans le G-code par le moteur (`extra` non émis). C'est donc l'application qui doit dire quoi charger.

### Échange guidé (après l'essai U1)

- Proposer de charger ou décharger la bobine depuis la carte, via `AUTO_FEEDING`, **uniquement** si l'essai (3) est concluant.
- Sinon, laisser l'utilisateur faire l'échange sur l'écran de la U1, puis Reprendre dans Snap Studio.

### Hors périmètre

- Modifier le moteur ou post-traiter le G-code (écarté dès l'analyse).
- Gérer le HRM ou le lissage des têtes virtuelles sur les hauteurs (limitations déjà signalées aux étapes 1 et 2).
- Changer le comportement d'une pause manuelle sans plan.

## Intégration UI

- Préparer : le plan apparaît dans la section « Couleurs par hauteur » et dans la feuille de découpe (maquette 4a).
- Impressions : carte de pause prévue (maquette 4b).
- Contrôle : assouplissement éventuel de `control.rs:388-418`, seulement après l'essai `AUTO_FEEDING`.

Libellés dans les neuf catalogues, français en « vous ».

## Checklist

- [ ] Les deux essais U1 (qualité sans tour, pause `M600` + échange + reprise) sont faits et documentés
- [ ] Calcul du plan de bobines (4, 5, 8 couleurs) et choix de la tête à recharger
- [ ] Pause insérée une couche avant le besoin
- [ ] Option « Regrouper les rechargements »
- [ ] Résumé dans la feuille de découpe
- [ ] Plan stocké dans le job
- [ ] Carte « Chargez X sur Tn » dans Impressions, avec Reprendre
- [ ] Vérification des bobines au départ : têtes initiales + rappel des recharges
- [ ] Échange guidé **masqué ou désactivé** tant que `AUTO_FEEDING` en pause n'est pas validé sur U1
- [ ] Textes d'interface dans `en.json` et `fr.json` (`python3 scripts/check-i18n.py` propre)
- [ ] Entrée *Unreleased* dans `CHANGELOG.md`

## Tests

- Tests unitaires : plan de bobines pour 4, 5 et 8 couleurs ; regroupement (1 pause au lieu de 2) ; choix d'une tête qui ne resservira plus ; pause calée une couche avant.
- Test moteur (étape 1) : `;PAUSE_PRINT` + `M600` présents à la bonne couche, puis `T<n>` à la couche suivante.
- Sur une vraie U1, en plus des prérequis :
  - un HueForge 6 couleurs avec pause prévue, carte dans Impressions, reprise sans décalage ;
  - un départ depuis la file avec une bobine différente de celle du plan ;
  - si l'essai `AUTO_FEEDING` est positif : un échange guidé depuis la carte.

## Maquettes

4a. Plan de bobines : `docs/hueforge/mockups/4a-spool-plan-light-fr.png`
4b. Impressions pendant une pause prévue : `docs/hueforge/mockups/4b-prints-pause-light-fr.png`
