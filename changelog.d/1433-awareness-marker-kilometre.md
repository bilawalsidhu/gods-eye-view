- Show a Contacts marker 999.5 m or more away as 1.0 km. The on-globe marker
  chose metres before rounding, so 999.6 m read "1000 m" while the panel read
  "1.0 km" (Aditya, @Rohilalala, #1433).
- Distance labels share one formatter that takes each unit cut after rounding,
  so the Contacts panel and markers, the drawn-line measure and the Cockpit
  show 9.96 km as 10 km rather than 10.0 km (#1433).
