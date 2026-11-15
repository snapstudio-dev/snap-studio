# Couleurs par hauteur (HueForge), étape 2 : mode « Par hauteur » et import HueForge

Cette étape ajoute, dans **Préparer**, le mode « Par hauteur » et l'import des fichiers HueForge. Elle s'appuie sur le socle de l'étape 1 (transport vers le moteur, calage sur les couches, lecture et écriture du XML, repères en lecture seule dans l'aperçu).

Analyse complète : [docs/hueforge/analyse.md](../hueforge/analyse.md), notamment §3 (compatibilité HueForge), §4 proposition A et §5 (recommandation). Maquettes : `docs/hueforge/mockups/` (écrans 1, 2 et 3).

**Dépend de l'étape 1.** Le travail au-delà de 4 couleurs (plan de bobines, pauses groupées, carte dans Impressions) est l'étape 3.

## Objectif

Permettre de planifier les changements de couleur **avant la découpe**, avec un aperçu du modèle teinté par hauteur, et d'importer un fichier HueForge (3MF ou describe) sans recopier les hauteurs à la main.

## Périmètre

### Mode « Par hauteur » dans Préparer

- Un 3e choix à côté de « Par objet / Par couleur » (`ui/index.html`, vers les lignes 339-342).
- À l'import HueForge, la plaque passe automatiquement dans ce mode.
- Incompatible, avec un message clair (déjà bloqué à la découpe par l'étape 1) : plusieurs têtes par objet, peinture, piliers par matériau, impression objet par objet.

### Règle verticale et modèle teinté

- Une règle de hauteur s'affiche à côté de la vue 3D de Préparer (près de `p-canvas`).
- Elle montre des bandes de couleur ; chaque bande porte une pastille de tête (T0 à T3, ou une tête virtuelle).
- Le modèle 3D est **teinté par tranches de Z** avant toute découpe (moteur de rendu WebGL existant). C'est l'aperçu HueForge qu'Orca ne montre pas avant la découpe.
- Les couches se calculent dans l'interface : première couche + *n* × couche, tant que les couches sont uniformes. Le lissage des têtes virtuelles et le modificateur de plage (HRM) ne sont pas gérés : un avertissement le signale.

### Liste dans l'inspecteur

- Une section « Couleurs par hauteur » dans `p-insp` liste les changements : hauteur en mm, n° de couche, tête cible avec sa bobine réelle, type « Automatique » ou « Pause ».
- On peut **ajouter** (bouton de la liste, ou clic sur la règle à la hauteur voulue), **déplacer** (en saisissant la hauteur dans la liste) ou **supprimer** un changement. Chaque hauteur se cale sur le haut d'une couche réelle (jamais la première), avec son n° de couche affiché.
- La tête se choisit avec le sélecteur de têtes habituel ; une bascule transforme le changement en pause pour changer de bobine (même tête).
- Livré sous cette forme (PR #103) : la liste est au-dessus des objets, dans `p-list`, et non dans `p-insp`. Le glisser sur la règle et la bulle « Ajouter un changement » de la maquette 2 sont reportés (voir hors périmètre).

### Import HueForge

Feuille « Importer depuis HueForge » (maquette 3), deux entrées :

1. **3MF** (HueForge « 3MF Export » ou Orca) : lire `Metadata/custom_gcode_per_layer.xml`, les couleurs (`project_filaments`), `layer_height` et `initial_layer_print_height` dans `project_settings.config`. Les numéros d'extrudeur du projet passent par la correspondance couleur → tête de Snap Studio. Le XML est déjà lu par l'étape 1 ; cette étape en fait un parcours d'import guidé.
2. **Description** (fichier `describe` ou texte collé, souvent repris d'une fiche MakerWorld) : analyser `layer height of X`, `base layer of Y`, les lignes `#hex …` et `Start with …` / `At layer #n (z mm) swap to …`. La hauteur en mm fait foi ; le n° de couche ne sert qu'à vérifier. Les noms des lignes d'échange se rapprochent des lignes `#hex` par nom de couleur.

Dans les deux cas :

- imposer la couche et la première couche (et le remplissage 100 % si le describe le demande) ;
- caler chaque hauteur sur une couche réelle, avec un avertissement si l'écart dépasse 0,01 mm ;
- associer chaque couleur à une tête T0–T3 (identique ou la plus proche) ;
- signaler le modificateur de plage (HRM) s'il est présent et n'est pas repris (couche fine partout : résultat juste, plus lent) ;
- avertir si une couleur n'est pas chargée.

### Hors périmètre (étape 3 ou plus tard)

- Déplacer un changement en le glissant sur la règle, et la bulle « Ajouter un changement » (−1 / +1, aperçu des couches).
- Résumé des changements dans la feuille de découpe.
- « Par hauteur » comme mode par défaut dans les Réglages (le menu garde « Par objet / Par couleur »).

- Plan automatique de bobines au-delà de 4 couleurs, regroupement des rechargements, pause prévue une couche avant.
- Carte « Chargez X sur Tn » dans Impressions, et échange guidé.
- G-code personnalisé (usage secondaire, possible plus tard).

## Modèle de données

- Sur la plaque : `PR.hz = { base, changes: [{ z, head, kind: "auto"|"pause" }], layers, src, infill100?, warnings? }`, inclus dans les étapes d'annulation et dans la sauvegarde. `base` est la tête de départ ; les têtes sont celles de l'interface (0-3, ou une tête virtuelle), converties à la découpe.
- Le mode de la plaque vaut « Par hauteur » (`PR.assoc = "height"`). Un objet de plusieurs couleurs (peint, ou fichier multicolore) bloque la découpe dans ce mode.
- L'écriture de `Metadata/custom_gcode_per_layer.xml` et le transport `Request.height_changes` → `--load-custom-gcodes` sont livrés à l'étape 1. Cette étape alimente `PR.hz` depuis l'interface et l'import (`hzRequest` dans `ui/heights-logic.js`).
- Conversion déjà définie à l'étape 1 : tête physique *h* → filament *h*+1, tête virtuelle *k* → filament *n*+*k*+1, pause → `PausePrint`.

## Intégration UI

- Préparer : mode « Par hauteur », règle verticale, section dans l'inspecteur, teinte du modèle, feuille d'import.
- Feuille de découpe : pas de résumé dans ce lot (reporté).
- Aperçu : les repères en lecture seule sur `v-layer` viennent de l'étape 1 ; après découpe, les bandes apparaissent déjà en mode Filaments grâce aux `T<n>`.

Libellés dans les neuf catalogues, français en « vous », comme le reste de l'app.

## Checklist

- [x] Mode « Par hauteur » à côté de « Par objet / Par couleur », activé automatiquement à l'import HueForge
- [x] Règle verticale avec bandes de couleur (nom de la bobine au survol)
- [x] Modèle teinté par hauteur avant la découpe
- [x] Liste des changements : ajouter, déplacer en saisissant la hauteur (calage sur une couche), supprimer
- [ ] Glisser sur la règle et bulle « Ajouter un changement » (reportés)
- [x] Import 3MF : XML, couleurs, hauteurs de couche imposées, correspondance couleur → tête
- [x] Import describe (fichier ou texte collé) : mêmes réglages imposés et même calage
- [x] Avertissements : HRM non repris, écart de hauteur > 0,01 mm, couleur non chargée
- [x] Blocages du mode incompatibles (objet multicolore, peinture, piliers, objet par objet)
- [x] Tour de purge et têtes virtuelles comptent les têtes du plan
- [x] Textes d'interface dans les neuf catalogues (`python3 scripts/check-i18n.py` propre)
- [x] Entrée *Unreleased* dans `CHANGELOG.md`

## Tests

- Tests unitaires : analyse du describe (exemples publics du §3), calage hauteur → couche, application des couches imposées, association couleur → tête.
- Tests d'interface : passage dans le mode, édition de la liste, import d'un describe et d'un 3MF de fixture, teinte du modèle (harness existant si possible).
- Le test moteur `T<n>` / `;PAUSE_PRINT` reste celui de l'étape 1.
- Contrôle manuel : ouvrir un describe, un 3MF HueForge, ajouter ou déplacer un changement, vérifier que la découpe reprend les hauteurs calées.

## Maquettes

1. Préparer en mode « Par hauteur » : `docs/hueforge/mockups/1-prepare-by-height-light-fr.png`
2. Ajouter un changement : `docs/hueforge/mockups/2-edit-change-light-fr.png`
3. Importer depuis HueForge : `docs/hueforge/mockups/3-hueforge-import-light-fr.png`
