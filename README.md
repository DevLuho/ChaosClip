# ChaosClip

Petite appli locale et gratuite pour faire des GIF (et WebP, MP4, WebM) précis à partir d'une vidéo, pour Discord et Chaos:Reborn.

- **Source** : une URL (YouTube et [tous les sites gérés par yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)), un chemin de fichier, ou un fichier glissé dans la fenêtre. Les URL sont téléchargées dans la meilleure qualité disponible (meilleure vidéo + meilleur son).
- **Découpe à l'image près** : avance image par image, début / fin au numéro d'image, lecture en boucle de la sélection.
- **Réglages** : recadrage à la souris (libre, 1:1, 16:9, 4:3, 9:16), largeur, FPS, vitesse, boucle, aller-retour (boomerang), texte incrusté, sous-titres de la vidéo (pistes texte des MKV, avec leurs polices).
- **Export** : GIF optimisé (palette sur mesure, tramage réglable, nombre de couleurs), WebP animé, MP4 (H.264), WebM (VP9), avec ou sans son.
- **Poids** : estimation avant export, et poids max (10 Mo pour Discord, 25, 50 ou autre) : l'export réduit automatiquement la largeur, puis le FPS (GIF/WebP) ou le débit (MP4/WebM) jusqu'à passer dessous.

## Installation (Windows)

1. Installer [Node.js](https://nodejs.org) (version LTS).
2. Télécharger ce dépôt (bouton **Code › Download ZIP**, ou `git clone`).
3. Double-cliquer sur **`Lancer ChaosClip.bat`**. La première fois, il installe les dépendances (ffmpeg est inclus) puis ouvre l'appli dans le navigateur. yt-dlp est téléchargé automatiquement au premier lancement et mis à jour à chaque démarrage.

En ligne de commande : `npm install` puis `npm start`. L'appli tourne sur http://localhost:4870 et n'est accessible que depuis ton PC.

## Utilisation

1. Colle une URL ou un chemin (dans l'Explorateur : clic droit sur le fichier › *Copier en tant que chemin d'accès*), puis **Charger**.
2. Place-toi sur la première image et appuie sur **I**, sur la dernière et appuie sur **O**.
3. Glisse sur la vidéo pour recadrer, règle le format à droite.
4. **Estimer le poids** si besoin, puis **Exporter**. Le fichier est dans le dossier `exports/`.

| Touche | Action |
|---|---|
| ← / → | image précédente / suivante |
| Maj + ← / → | 10 images |
| Espace | lecture / pause |
| I / O | début / fin de la sélection |

Les vidéos téléchargées restent dans `telechargements/` : pour les reprendre plus tard, colle leur chemin.

Si l'aperçu reste noir (HEVC, 10 bits…), clique sur **Créer une copie lisible** : seul l'aperçu est converti, l'export part toujours du fichier d'origine.

## Conseils GIF

- Pour l'animé, **Sierra lite** donne les dégradés les plus propres ; **Bayer** compresse mieux ; **Aucun** garde des aplats nets.
- Le poids d'un GIF dépend surtout de largeur × FPS × durée : 480 px à 15 i/s est un bon point de départ pour Discord.
- Un WebP ou un MP4 est 5 à 10 fois plus léger qu'un GIF à qualité égale.

## Avertissement

ChaosClip utilise [yt-dlp](https://github.com/yt-dlp/yt-dlp) et [ffmpeg](https://ffmpeg.org). Tu es responsable de ce que tu télécharges : respecte les droits d'auteur et les conditions des sites. L'appli ne contourne aucune protection (DRM) : les contenus protégés (Crunchyroll, Netflix…) ne sont pas pris en charge.

## Développement

`npm test` génère une vidéo de test et vérifie chaque format, la précision à l'image et le poids max.

Licence MIT.
