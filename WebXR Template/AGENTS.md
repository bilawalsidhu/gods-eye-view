# WebXR project guidance

- This directory is independently runnable. Use its own `package.json`, `package-lock.json`, and `README.md`; run `npm ci`, `npm test`, and `npm run build` here before treating work as complete.
- Start new projects by copying the clean template with the repository's `npm run new:project -- <name>` command. Do not copy `node_modules`, `dist`, caches, or test output.
- Keep project lessons, branding, deployment settings, and customer assets local to each project. Keep the template generic.
- The shared template defaults to the neutral identity. New identities live in the parent repository's `brands/` packs; never assume a new project should carry ProtoGen branding. Existing legacy projects may still have brand-specific UI code.
- For locomotion, controllers, hands, grabbing, rays, XR fallbacks, and other reusable WebXR behavior, compare the template and sibling projects. Promote generally useful project fixes to the template, then integrate template changes into affected siblings. If this folder is used outside the parent repository, record the upstream sync needed rather than assuming siblings are available.
- For Blender-authored work, treat the editable source as canonical, verify the local Blender MCP bridge before using it, and rebuild and test affected runtime assets.
- Within the parent ProtoGen repository, reusable models, textures, media, and editable sources belong in the root `assets/` catalog. Projects load a synced local copy so they remain independently buildable. Catalog a project-created reusable asset and collect it into the library before completion; update the library first, then sync it back to consumers. See `../assets/README.md` when working in the monorepo.
- Read the local `README.md` for project-specific setup and validation. Headset behavior still needs physical-device verification.
