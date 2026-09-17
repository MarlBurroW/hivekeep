# Sauvegarde complète et retour arrière

`bun run backup` sauvegarde les données, sans démarrer Hivekeep ni appeler de fournisseur. `db:snapshot` reste un outil SQLite uniquement.

## Créer une sauvegarde

Arrêter Hivekeep et les processus qui modifient ses fichiers, puis lancer avec les mêmes variables de stockage que le service :

```sh
# Le répertoire de destination doit être nouveau et hors des données sources.
bun run backup create --stopped --to /srv/backups/hivekeep-2026-09-16
bun run backup verify --from /srv/backups/hivekeep-2026-09-16
```

`--stopped` confirme que les écritures applicatives sont arrêtées ; il n'arrête pas le service à votre place. Une transaction SQLite empêche les écritures DB pendant la copie ; un inventaire avant/après refuse les fichiers qui ont changé. La sauvegarde inclut les pages SQLite présentes dans le WAL.

Sont inclus : tout `HIVEKEEP_DATA_DIR`, la base désignée par `DB_PATH`, la clé de chiffrement effective, plugins, marqueurs de migration, fichiers, espaces de travail, Apps, données de canaux et états de navigateur. Les stockages configurés hors du répertoire de données sont inclus via `VAULT_ATTACHMENT_DIR`, `WORKSPACE_BASE_DIR`, `UPLOAD_DIR`, `FILE_STORAGE_DIR`, `WHATSAPP_WEB_DIR`, `BROWSER_STATES_DIR`, `MINI_APPS_DIR` et `HIVEKEEP_CUSTOM_TOOLS_DIR`.

Les dossiers ajoutés manuellement dans Fichiers peuvent désigner des projets sans rapport avec Hivekeep. Une sauvegarde les rencontre hors des stockages gérés : elle refuse de continuer sans `--include-folders`, qui les inclut explicitement. Les liens internes sont conservés ; un lien vers l'extérieur ou un fichier spécial doit être traité avant de relancer la sauvegarde. Aucun fichier n'est ignoré silencieusement.

Le dossier produit est privé (`0700`), les fichiers de sauvegarde sont en `0600`, et un manifeste contient des sommes SHA-256. La clé de chiffrement est incluse : le dossier est sensible et doit être conservé sur un stockage protégé. Le format est un répertoire non compressé. La sérialisation SQLite utilise temporairement une quantité de mémoire proportionnelle à la base. La configuration réseau, les unités systemd, le proxy, les variables de fournisseurs et le code applicatif restent à conserver séparément.

## Restaurer sans toucher à l'installation

```sh
# Refuse toute destination déjà existante.
bun run backup restore --from /srv/backups/hivekeep-2026-09-16 --to /srv/hivekeep-restore-test
```

La restauration vérifie les empreintes et l'intégrité SQLite avant copie. Elle conserve les permissions exécutables des plugins et crée `restore-env.json` avec les nouveaux chemins de stockage. Les chemins des espaces de travail et fichiers enregistrés en DB sont adaptés au nouveau répertoire ; le contenu des conversations reste inchangé. Aucun service ne démarre, aucun identifiant n'est envoyé à un fournisseur.

Réglages → Général affiche la dernière vérification réussie enregistrée par la CLI pour le répertoire de données actuel. Cette indication est réservée aux administrateurs ; elle n'annonce pas de sauvegarde automatique et ne révèle aucun chemin. Une restauration dans un nouveau répertoire repart avec un statut inconnu. Le succès de `verify` ne crée un marqueur que si `--data-dir` ou `HIVEKEEP_DATA_DIR` désigne l'installation d'origine.

Pour une reprise réelle, utiliser la même version applicative que celle du manifeste, ou une version dont les migrations ont été vérifiées sur cette copie. Reporter les valeurs de `restore-env.json` dans la configuration du service. Si une ancienne variable `ENCRYPTION_KEY` est encore configurée, elle doit correspondre à la clé restaurée ; sinon elle prendrait la priorité. Contrôler comptes, pièces jointes et déchiffrement avant de réactiver ordonnanceurs et intégrations.

Les tests automatisés restaurent une base temporaire, déchiffrent un secret connu, lisent une pièce jointe par son chemin DB restauré et chargent un plugin. Ils ne constituent pas une vérification d'une sauvegarde de production particulière.

## Contrat de migration et retour arrière

- **Navigation/UI** : revenir au code précédent sans restaurer une vieille base. Restaurer une sauvegarde après de nouvelles écritures ferait perdre celles-ci.
- **Queue durable** : migration additive. Une ancienne version peut ignorer les nouvelles métadonnées ; ne pas revenir en arrière avec des items en attente sans avoir drainé la file ou validé cette compatibilité.
- **Plugins** : le stockage actif est `HIVEKEEP_DATA_DIR/plugins`. La migration conserve les anciens dossiers du projet ; les collisions gardent la copie du répertoire de données et sont journalisées. Les marqueurs `.plugin-migrations` empêchent de réimporter un plugin supprimé. Un retour à une version utilisant l'ancien emplacement nécessite de synchroniser explicitement les versions installées depuis la migration.
- **Mise à jour d'un plugin** : la version candidate est préparée, vérifiée puis activée. Une erreur restaure la version précédente. Un arrêt pendant le remplacement laisse une copie de reprise, restaurée au prochain démarrage.
- **Scripts npm** : les installations utilisent `--ignore-scripts`. Un plugin nécessitant une compilation native doit publier ses artefacts ; aucun bouton ne relance implicitement ses scripts avec les droits du serveur.
- **Reprise complète** : conserver la sauvegarde originale et restaurer dans un nouveau dossier. La bascule du service intervient après vérification ; une ancienne capture SQLite seule ne restaure ni pièces jointes ni clé ni plugins.

## Vérification du projet

```sh
# Version partagée par .bun-version, CI et Docker : Bun 1.4.0.
bun run test                         # fichiers isolés, 4 workers maximum par défaut
bun run test backup-files plugin-files  # filtre sur les chemins
TEST_CONCURRENCY=2 bun run test      # limite configurable entre 1 et 16
```

Chaque fichier de tests reçoit son propre processus, son environnement minimal, sa clé synthétique et son répertoire temporaire. Les mocks ne traversent pas les suites. Un test ignoré ou une suite sans test exécuté fait échouer le runner ; les totaux exécutés, échoués et ignorés sont affichés en CI.
