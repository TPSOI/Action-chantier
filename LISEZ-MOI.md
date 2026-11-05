# Actions chantiers — application Android (.apk) partagée

Application identique à l'artefact (onglets TPSOI / Citanéa / SPS, conducteurs, chefs, export PDF),
avec une base **Firebase** commune : téléphones et ordinateurs voient les mêmes données en temps réel.
Elle fonctionne aussi hors ligne et se resynchronise au retour du réseau.

## 1. Créer le projet Firebase (≈ 10 min, gratuit)
1. https://console.firebase.google.com → **Ajouter un projet** (nom libre, Analytics inutile).
2. **Build > Authentication > Commencer > E-mail/Mot de passe** : activer.
3. **Authentication > Utilisateurs > Ajouter un utilisateur** : crée un compte par personne (toi, collègues).
   Il n'y a pas d'inscription libre dans l'application : seuls ces comptes peuvent entrer.
4. **Build > Firestore Database > Créer** (mode production, région `europe-west`).
   Onglet **Règles** : colle le contenu de `firestore.rules` puis **Publier**.
5. **Paramètres du projet (roue dentée) > Vos applications > icône Web `</>`** : enregistre une application,
   copie l'objet `firebaseConfig` et colle ses valeurs dans `src/firebase-config.js`.

## 2. Obtenir l'APK — au choix

### A. Sur GitHub (aucune installation)
1. Crée un dépôt GitHub **privé** et envoie-y tout ce dossier.
2. Onglet **Actions > Build APK > Run workflow**.
3. Une fois terminé, télécharge l'artefact `Actions-chantiers-apk` : il contient `app-debug.apk`.

### B. Sur ton PC avec Android Studio
1. Installe Node.js 20+ et Android Studio.
2. Dans ce dossier : `npm install` puis `npm run android:sync` puis `npm run android:open`.
3. Dans Android Studio : **Build > Build APK(s)**. Le fichier est dans `android/app/build/outputs/apk/debug/`.

## 3. Installer
Envoie `app-debug.apk` sur le téléphone et ouvre-le (autoriser « sources inconnues » si demandé).
Sur ordinateur : ouvre simplement la version web (`npm run build`, puis héberge `dist/` ou
Firebase Hosting), ou utilise `npm run dev` en local.

## À savoir
- Chaque chantier est un document : si deux personnes modifient **le même chantier** exactement au même
  moment, la dernière écriture gagne. Sans conséquence en usage normal, à garder en tête.
- Après toute modification du code web : `npm run android:sync`, puis recompiler.
- L'APK « debug » convient à un usage interne. Pour le Play Store il faudrait une version signée.
- Icône d'application : par défaut celle de Capacitor ; remplaçable dans Android Studio
  (clic droit sur `res` > New > Image Asset) avec un logo.
- Sans configuration Firebase, l'application démarre en **mode local** (données sur l'appareil seulement).
