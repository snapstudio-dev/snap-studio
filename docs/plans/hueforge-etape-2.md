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
- On peut **ajouter**, **déplacer** (glisser sur la règle, calage magnétique sur les couches) ou **supprimer** un changement.
- La bulle « Ajouter un changement » (maquette 2) cale la hauteur saisie sur une couche réelle (exemple : 0,50 mm → couche 5 · 0,48 mm, avec −1 / +1). On choisit une tête parmi les bobines chargées, ou « Pause pour changer de filament », et on voit un aperçu des couches concernées.

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

- Plan automatique de bobines au-delà de 4 couleurs, regroupement des rechargements, pause prévue une couche avant.
- Carte « Chargez X sur Tn » dans Impressions, et échange guidé.
- G-code personnalisé (usage secondaire, possible plus tard).

## Modèle de données

- Sur la plaque : `PR.heightChanges = [{ z, head, kind: "auto"|"pause", note? }]`, inclus dans les étapes d'annulation et dans la sauvegarde.
- Le mode de la plaque vaut « Par hauteur ».
- L'écriture de `Metadata/custom_gcode_per_layer.xml` et le transport `Request.height_changes` → `--load-custom-gcodes` sont livrés à l'étape 1. Cette étape alimente `heightChanges` depuis l'interface et l'import.
- Conversion déjà définie à l'étape 1 : tête physique *h* → filament *h*+1, tête virtuelle *k* → filament *n*+*k*+1, pause → `PausePrint`.

## Intégration UI

- Préparer : mode « Par hauteur », règle verticale, section dans l'inspecteur, teinte du modèle, feuille d'import.
- Feuille de découpe : un résumé simple des changements (sans le plan de bobines de l'étape 3).
- Aperçu : les repères en lecture seule sur `v-layer` viennent de l'étape 1 ; après découpe, les bandes apparaissent déjà en mode Filaments grâce aux `T<n>`.

Libellés dans les neuf catalogues, français en « vous », comme le reste de l'app.

## Checklist

- [ ] Mode « Par hauteur » à côté de « Par objet / Par couleur », activé automatiquement à l'import HueForge
- [ ] Règle verticale avec bandes de couleur et pastilles de tête
- [ ] Modèle teinté par hauteur avant la découpe
- [ ] Liste dans l'inspecteur : ajouter, déplacer (calage sur une couche), supprimer
- [ ] Bulle « Ajouter un changement » : calage, choix d'une tête ou d'une pause, aperçu des couches
- [ ] Import 3MF : XML, couleurs, hauteurs de couche imposées, correspondance couleur → tête
- [ ] Import describe (fichier ou texte collé) : mêmes réglages imposés et même calage
- [ ] Avertissements : HRM non repris, écart de hauteur > 0,01 mm, couleur non chargée
- [ ] Blocages du mode incompatibles (plusieurs têtes, peinture, piliers, objet par objet)
- [ ] Textes d'interface dans `en.json` et `fr.json` (`python3 scripts/check-i18n.py` propre)
- [ ] Entrée *Unreleased* dans `CHANGELOG.md`

## Tests

- Tests unitaires : analyse du describe (exemples publics du §3), calage hauteur → couche, application des couches imposées, association couleur → tête.
- Tests d'interface : passage dans le mode, édition de la liste, import d'un describe et d'un 3MF de fixture, teinte du modèle (harness existant si possible).
- Le test moteur `T<n>` / `;PAUSE_PRINT` reste celui de l'étape 1.
- Contrôle manuel : ouvrir un describe, un 3MF HueForge, ajouter ou déplacer un changement, vérifier que la découpe reprend les hauteurs calées.

## Maquettes

1. Préparer en mode « Par hauteur » : `docs/hueforge/mockups/1-prepare-by-height-light-fr.png`
2. Ajouter un changement : `docs/hueforge/mockups/2-edit-change-light-fr.png`
3. Importer depuis HueForge : `docs/hueforge/mockups/3-hueforge-import-light-fr.png`
