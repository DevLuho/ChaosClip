# ChaosClip

Appli locale et gratuite pour faire des GIF (et WebP, MP4, WebM, APNG, AVIF…) précis à partir d'une vidéo, pour Discord et Chaos:Reborn.

## Ce qu'elle fait

- **Sources** : une URL (YouTube, TikTok, Dailymotion, Twitter/X, Twitch, Bilibili et [tous les sites gérés par yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)), plusieurs URL d'un coup, une playlist, un fichier glissé dans la fenêtre, une suite d'images, ou une capture d'écran. Avant de télécharger : choix de la qualité, de la langue audio, des sous-titres, ou seulement d'un passage. Un site non pris en charge donne un message clair.
- **Découpe à l'image près** : image par image (molette, flèches, J/K/L), début et fin au numéro d'image, frise avec miniatures, détection des changements de plan, marqueurs, plusieurs segments collés dans un seul clip, arrêt sur image.
- **Image** : recadrage à la souris (libre, 1:1, 16:9, 9:16, bannière…), recadrage qui suit un personnage, suppression des bandes noires, rotation, miroir, zones floues, fond transparent à la pipette.
- **Animation** : vitesse, ralenti fluide, boucle, aller-retour, lecture inversée, fondu en boucle, fondus, zoom progressif.
- **Texte** : plusieurs textes déplaçables avec police, couleur, contour et durée ; sous-titres de la vidéo ou d'un fichier .srt/.ass ; logo.
- **Export** : GIF optimisé (palette sur mesure, tramage, couleurs, compression gifsicle), WebP, MP4 (accélération matérielle), WebM, APNG, AVIF, MP3, PNG, planche. Estimation du poids en direct, poids max (10 Mo pour Discord…) atteint automatiquement, file d'attente, plusieurs formats d'un coup, comparaison A/B.
- **Partage** : copier pour Ctrl+V dans Discord, glisser vers Discord, envoi dans un salon par webhook, **envoi sur ChaosBooru** (Chaos Tools).
- **Onglets** : chaque vidéo ou image ouverte a son onglet, avec ses réglages et sa position ; un export se rouvre dans un onglet pour le retravailler. Les images fixes et les WebP animés s'ouvrent aussi.
- Préréglages Discord (emoji, sticker, avatar, bannière), projets enregistrés, historique avec « Refaire », annuler/rétablir, raccourcis modifiables, thème clair/sombre, interface en français ou en anglais.

## Installation (Windows)

**Appli Windows (conseillé)** : télécharger `ChaosClip-Setup-x.y.z.exe` dans les [Releases](https://github.com/DevLuho/ChaosClip/releases) et l'installer. Rien d'autre à installer : ffmpeg est inclus, yt-dlp se télécharge au premier lancement. L'installateur ajoute un raccourci sur le bureau et **« Ouvrir avec ChaosClip »** au clic droit sur une vidéo. Les mises à jour se téléchargent seules et s'installent à la fermeture. Les exports vont dans `Vidéos\ChaosClip`.

**Sans installateur** : installer [Node.js](https://nodejs.org) (LTS), télécharger ce dépôt, puis double-cliquer sur **`Lancer ChaosClip.bat`**. L'appli s'ouvre dans le navigateur sur http://localhost:4870 (accessible depuis ton PC seulement). Les exports vont dans `exports/`.

## Utilisation

1. Colle une URL ou un chemin (Ctrl+V n'importe où), ou glisse une vidéo dans la fenêtre.
2. Place-toi sur la première image et appuie sur **I**, sur la dernière et appuie sur **O**.
3. Glisse sur la vidéo pour recadrer, règle le format à droite (mode Simple ou Avancé).
4. **Exporter** (Ctrl+Entrée). Puis **Copier** et Ctrl+V dans Discord, ou **ChaosBooru**.

Toutes les touches : bouton **?** (ou touche `?`). Elles se changent dans Réglages › Raccourcis clavier.

## ChaosBooru

Réglages › ChaosBooru › **Se connecter à Chaos Tools** (appli Windows : la page du site s'ouvre, on se connecte par Discord comme d'habitude). Dans le navigateur, colle à la place ton jeton : sur le site, F12 › Application › Stockage local › `chaos_token`. Le jeton reste sur ton PC (`data/booru.json`) et n'est jamais envoyé ailleurs qu'à Chaos Tools.

Après un export en GIF, WebP ou PNG, **ChaosBooru** ouvre le formulaire : titre, support, tags, personnages et œuvres. L'envoi crée la contribution et la soumet à la modération (ou la garde en brouillon).

## Avertissement

ChaosClip utilise [yt-dlp](https://github.com/yt-dlp/yt-dlp) et [ffmpeg](https://ffmpeg.org). Tu es responsable de ce que tu télécharges : respecte les droits d'auteur et les conditions des sites. L'appli ne contourne aucune protection (DRM) : les contenus protégés (Crunchyroll, Netflix…) ne sont pas pris en charge. Les cookies du navigateur (réglage optionnel) servent seulement aux vidéos que ton compte peut déjà voir.

## Développement

- `npm start` : serveur seul (navigateur). `npm run app` : appli Electron. `npm run dist` : installateur Windows dans `dist/`.
- `npm test` : génère une vidéo de test et vérifie chaque format, la précision à l'image, le poids max et l'envoi ChaosBooru (contre un faux Chaos Tools).
- Chaque push lance les tests sur Windows et Linux et construit un installateur de test (onglet *Actions › Artifacts*).
- **Publier une version** : changer `version` dans `package.json`, pousser, puis *Actions › Release › Run workflow* : il crée le tag `vX.Y.Z`, construit l'installateur et le publie dans les Releases, où l'appli installée va chercher ses mises à jour.

Licence MIT.
