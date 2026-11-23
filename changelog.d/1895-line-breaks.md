- A line can be drawn as several runs (`LineItem.breaks`, capability
  `lineBreaks`): the segments across its breaks are not drawn nor picked,
  and each run has ends of its own, so many lines in one style, such as
  many moving objects' trails, can be sent as one item; the Cesium renderer
  draws it, draped or not (samehkhamis, #1895).
