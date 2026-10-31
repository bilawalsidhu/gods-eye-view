- Add optional keyless Radio priority-country coverage with up to 40 stations
  per configured country inside the existing 750-station cap. Country query
  failures do not block a healthy global catalog. Bound mirror attempts to three
  and retry failed or partial refreshes after 60 seconds on all installations,
  including those without priority countries configured (m3ayush, #1206).
