# blog

Blog statique : du Markdown qui compile en HTML, thème « Save Point ». Aucun studio, aucun serveur, aucune base.

## Écrire

Un article = un fichier `content/posts/<slug>.md` avec un frontmatter :

```markdown
---
title: Titre de l'article
date: 2026-11-20
level: 16
tags: kernel, pwn, android
excerpt: Résumé affiché sur l'accueil.
---

# Markdown ici

Les images vont dans `content/assets/` et se référencent en `![légende](assets/mon-image.png)`.
```

## Build

```bash
npm install
npm run build      # compile -> dist/
npm run serve      # build + sert dist/ sur http://localhost:8087
```

## Déploiement

Le workflow `.github/workflows/pages.yml` compile et publie `dist/` sur GitHub Pages à chaque push sur `main`.

Pré-requis une fois : **Settings → Pages → Build and deployment → Source : GitHub Actions**.

Domaine personnalisé : créer un fichier `CNAME` à la racine contenant le domaine (ex. `blog.exemple.com`), ou le renseigner dans **Settings → Pages**.
