# SOLOC — backend et interface reliée (v0.2)

Node ≥ 22.5, aucune dépendance obligatoire (le pilote `pg` n'est requis qu'en production PostgreSQL).

## Démarrer (développement, SQLite)
```
npm run seed     # comptes + véhicules de DÉMONSTRATION ; mots de passe affichés une seule fois
npm start        # http://localhost:3000  (migrations appliquées au démarrage)
npm test         # 69 tests (backend, audit, exploitation, paiement, e-mails, client mobile ; SQLite en mémoire)
npm run test:browser  # 55 contrôles Chromium (Playwright) : parcours, XSS, responsive, clavier
```
## Production (PostgreSQL 14+)
```
npm install pg
DATABASE_URL=postgres://... NODE_ENV=production npm run migrate && npm start
```
Extension `btree_gist` requise (contrainte anti-chevauchement). Variables : voir `.env.example`.
Servir derrière HTTPS (le cookie de session est `Secure` en production).

## Ce qui est fait
- Schéma + migrations (`db/migrations/pg` et `/sqlite`), prix figés dans chaque réservation, véhicules archivés jamais supprimés.
- Authentification (scrypt, sessions opaques hachées en base, cookie HttpOnly/SameSite), limitation des tentatives, rôles client / employé / administrateur, permissions côté serveur.
- Disponibilité et tarification calculées côté serveur ; transaction + verrou (`FOR UPDATE` sous PostgreSQL, `BEGIN IMMEDIATE` sous SQLite) + contrainte en base ; expiration des demandes non confirmées (24 h, `PENDING_TTL_HOURS`).
- Cycle : demande → confirmation/refus (admin) → remise → retour (avec état des lieux simplifié), annulation, encaissements manuels, journal d'audit.
- Interface (`public/`) reliée à l'API : catalogue, fiche, réservation avec création de compte, « Mes réservations », tableau de bord, calendrier, réservations, flotte.

## Limites connues (à lire)
- **PostgreSQL n'a pas été exécuté** : le schéma `pg` et l'adaptateur `pg` sont écrits mais non testés. Les tests tournent sur SQLite.
- Paiement en ligne (Stripe), e-mails, notifications push, stockage de photos, PDF/contrats : **non implémentés**. Les encaissements sont saisis à la main (`method = manual`).
- Interface testée uniquement par vérification de syntaxe et appels HTTP ; pas de test navigateur. Les saisies km/carburant/montants utilisent des boîtes de dialogue `prompt()` provisoires.
- Pas encore : création/édition de véhicule dans l'interface (API prête), modification de dates, agences multiples (le lieu choisi n'est pas enregistré), photos, fuseaux horaires par agence (UTC ; « aujourd'hui » = jour UTC), politique RGPD (export/suppression), réinitialisation de mot de passe, vérification d'e-mail.
- Limiteur de tentatives en mémoire (un processus). CSP avec `unsafe-inline` pour les scripts (gestionnaires `onclick`).
- Pas de RLS Supabase : les autorisations sont appliquées dans l'API, la base n'est pas exposée aux clients.

## Audit
Voir `AUDIT.md` : résultats, défauts corrigés, points ouverts et vérifications impossibles.

## Mise en production
- `docs/DEPLOY.md` : environnements, variables, domaine, HTTPS, déploiement, sauvegardes, Stripe, e-mails, surveillance.
- `docs/ROLLBACK.md` : retour arrière et incidents. `docs/READINESS.md` : **état réel de chaque élément (vérifié / non vérifié)** et liste de contrôle.
- `docs/DONNEES-PERSONNELLES.md` : inventaire des données (base de la politique de confidentialité).
- `mobile/RELEASE.md` : builds de test et publication sur les stores.
- Commandes : `npm run check:config [-- --online]`, `npm run create-admin`, `npm run backup:sqlite` (dev), `ops/deploy.sh`, `ops/rollback.sh`, `ops/backup.sh`, `ops/verify-restore.sh`.
