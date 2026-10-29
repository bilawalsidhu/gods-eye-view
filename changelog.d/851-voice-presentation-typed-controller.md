- Keep the policy-only voice presentation resolver truthful for controller
  sessions: unsupported states (including `ready`) return idle, and only
  literal boolean activity flags can imply ongoing speech or actions. The
  voice card/HUD still does not consume the resolver; no voice UX claim.
  Reviewer feedback: quanticsoul4772 on #851; original downstream repair
  from #265 and prior #837 compatibility review by asturksever.
