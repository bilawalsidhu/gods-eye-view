- Add 34 keyless feeds to the Transit layer, the first in Central and Eastern
  Europe, Italy, Spain, France, Japan and Malaysia: Szczecin, Lisbon (Carris
  Metropolitana and the city's Carris), Prague, Warsaw, Kraków, Poznań,
  Gdańsk, Rzeszów, Vilnius, Bucharest, Cluj-Napoca, Iași, Rome, Turin, Venice
  (buses and waterbuses), Bordeaux, Montpellier, Rouen, Toulon, Le Havre,
  Tours, Málaga, Sendai, Johor Bahru, Kota Bharu, Adelaide, Atlanta, Denver,
  Edmonton, Halifax and Victoria. Each feed records its licence, or that none
  is stated, in the registry and DATA_SOURCES.md. Speeds published in km/h
  (Lisbon, Montpellier, Toulon) are converted to m/s by the proxy; route ids
  read as the line on the vehicle; Prague metro, trains, trams and ferries,
  Bordeaux trams and boats, the Rouen Métro, Le Havre trams and Venice
  waterbuses take their own mode. The Warsaw and Poznań credits carry the
  data date their terms ask for, and the data.gov.my feeds are fetched at
  most twice a minute to stay inside the API's rate limit (IMBrandao).
