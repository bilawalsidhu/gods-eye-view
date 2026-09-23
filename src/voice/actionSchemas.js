// Canonical action arguments. Descriptive wording is supplied separately.
const schemas = [
  {
    name: 'fly_to_location',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        query: {
          type: 'string',
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
        },
        waitForArrival: {
          type: 'boolean',
        },
      },
    },
  },
  {
    name: 'select_nearest_aircraft',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
      },
      required: ['layerId'],
    },
  },
  {
    name: 'adjust_camera_zoom',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    name: 'zoom_to_globe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'set_layer_visibility',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'rocket-launches',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
            'alpr-cameras',
          ],
        },
        enabled: {
          type: 'boolean',
        },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    name: 'show_data_layers_menu',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
            'alpr-cameras',
          ],
        },
      },
    },
  },
  {
    name: 'set_panel_open',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: [
            'data-panel',
            'location-bar',
            'control-panel',
            'cctv-panel',
            'radio-panel',
            'scene-panel',
            'pp-toggles',
            'global-context-panel',
          ],
        },
        open: {
          type: 'boolean',
        },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    name: 'set_context_mode',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'control_cockpit',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
        },
        targetLayer: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'ais-live-vessels',
            'military-installations',
          ],
        },
        aircraftClass: {
          type: 'string',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_visual_style',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: [
            'normal',
            'retro',
            'surveillance',
            'thermal',
            'anime',
            'noir',
            'snow',
          ],
        },
      },
      required: ['style'],
    },
  },
  {
    name: 'get_entity_context',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view'],
        },
        layerId: {
          type: 'string',
          enum: [
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    name: 'get_current_view_state',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'set_hud',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: {
          type: 'string',
          enum: ['on', 'off', 'auto'],
        },
        layout: {
          type: 'string',
          enum: ['tactical', 'operator', 'minimal'],
        },
      },
    },
  },
  {
    name: 'set_detection',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
        },
        mode: {
          type: 'string',
          enum: ['sparse', 'balanced', 'dense'],
        },
        densityPct: {
          type: 'number',
        },
        allocationStrategy: {
          type: 'string',
          enum: ['elastic', 'weighted'],
        },
      },
    },
  },
  {
    name: 'set_map_stack',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: [
            'photoreal',
            'bing-aerial',
            'bing-labels',
            'esri-imagery',
            'osm',
          ],
        },
      },
      required: ['stack'],
    },
  },
  {
    name: 'set_post_processing',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
            },
            intensityPct: {
              type: 'number',
            },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
            },
            intensityPct: {
              type: 'number',
            },
          },
        },
      },
    },
  },
  {
    name: 'control_scene',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'play', 'stop', 'next', 'status'],
        },
        sceneId: {
          type: 'string',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_cctv',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'select',
            'next',
            'prev',
            'nearest',
            'focus',
            'coverage',
            'viewshed',
            'adjust',
            'projection',
            'autohop',
          ],
        },
        cameraQuery: {
          type: 'string',
        },
        enabled: {
          type: 'boolean',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'control_radio',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'play',
            'resume',
            'pause',
            'stop',
            'next',
            'previous',
            'volume',
            'select',
            'status',
          ],
        },
        volumePct: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        category: {
          type: 'string',
          enum: [
            'all',
            'news',
            'talk',
            'weather',
            'public-safety',
            'aviation-marine',
            'traffic-transit',
            'music',
          ],
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
        },
        locationQuery: {
          type: 'string',
          maxLength: 120,
        },
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        country: {
          type: 'string',
          maxLength: 80,
        },
        stationQuery: {
          type: 'string',
          maxLength: 120,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'track_entity',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
        },
        layerId: {
          type: 'string',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'stop_tracking',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'frame_overhead',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['flights', 'military', 'satellites', 'vessels'],
        },
        radiusKm: {
          type: 'number',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'annotate_map',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
              },
              target: {
                type: 'string',
                maxLength: 200,
              },
              points: {
                type: 'array',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: {
                      type: 'string',
                      maxLength: 200,
                    },
                    latitude: {
                      type: 'number',
                      minimum: -90,
                      maximum: 90,
                    },
                    longitude: {
                      type: 'number',
                      minimum: -180,
                      maximum: 180,
                    },
                    screenX: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                    },
                    screenY: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                    },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
              },
              latitude: {
                type: 'number',
                minimum: -90,
                maximum: 90,
              },
              longitude: {
                type: 'number',
                minimum: -180,
                maximum: 180,
              },
              toTarget: {
                type: 'string',
                maxLength: 200,
              },
              toLatitude: {
                type: 'number',
                minimum: -90,
                maximum: 90,
              },
              toLongitude: {
                type: 'number',
                minimum: -180,
                maximum: 180,
              },
              label: {
                type: 'string',
                maxLength: 120,
              },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
              },
              footprint: {
                type: 'boolean',
              },
              intent: {
                type: 'string',
                enum: ['the_thing', 'around_the_thing'],
              },
              entityKind: {
                type: 'string',
                enum: [
                  'building',
                  'compound',
                  'district',
                  'street',
                  'point_feature',
                ],
              },
              screenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              screenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              toScreenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              toScreenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
            },
            required: ['type'],
          },
        },
        flyTo: {
          type: 'boolean',
        },
        persist: {
          type: 'boolean',
        },
      },
      required: ['annotations'],
    },
  },
  {
    name: 'clear_annotations',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'move_camera',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: {
          type: 'string',
          enum: ['orbit', 'pan', 'tilt', 'rotate', 'stop'],
        },
        direction: {
          type: 'string',
          enum: ['left', 'right', 'up', 'down'],
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
        },
        mode: {
          type: 'string',
          enum: ['once', 'continuous'],
        },
      },
      required: ['motion'],
    },
  },
  {
    name: 'fly_route',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: {
          type: 'string',
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
        },
      },
    },
  },
  {
    name: 'analyst_query',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'flights',
              'military',
              'ais-live-vessels',
              'local-firms',
              'earthquakes',
              'satellites',
              'local-datacenters',
              'local-dams',
            ],
          },
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['view', 'region', 'radius', 'anywhere'],
            },
            name: {
              type: 'string',
            },
            km: {
              type: 'number',
            },
            center: {
              type: 'object',
              additionalProperties: false,
              properties: {
                lat: {
                  type: 'number',
                },
                lon: {
                  type: 'number',
                },
              },
            },
          },
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: {
                type: 'string',
              },
              op: {
                type: 'string',
                enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'],
              },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: {
          type: 'string',
        },
        sortDir: {
          type: 'string',
          enum: ['asc', 'desc'],
        },
        limit: {
          type: 'number',
        },
        followUp: {
          type: 'boolean',
        },
      },
    },
  },
  {
    name: 'next_iss_pass',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
        minElevationDeg: {
          type: 'number',
          minimum: 5,
          maximum: 60,
        },
      },
    },
  },
  {
    name: 'next_satellite_pass',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 120 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        minElevationDeg: { type: 'number', minimum: 5, maximum: 60 },
        visibleOnly: { type: 'boolean' },
      },
    },
  },
];

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Immutable action names and argument schemas, without model-facing wording. */
export const GEV_ACTION_SCHEMAS = freeze(schemas);

/** Build independent function-tool records with description-only metadata. */
export function createActionTools(descriptions = {}) {
  for (const name of Object.keys(descriptions)) {
    if (!schemas.some((schema) => schema.name === name))
      throw new TypeError('Unknown action description: ' + name);
  }
  return schemas.map((schema) => ({
    type: 'function',
    ...describe(schema, descriptions[schema.name] || {}),
  }));
}

function describe(schema, metadata, allowDescription = true) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new TypeError('Descriptions must be an object');
  const result = structuredClone(schema);
  for (const [key, value] of Object.entries(metadata)) {
    if (key === '$position' && allowDescription) continue;
    if (key === 'description' && allowDescription) {
      if (typeof value !== 'string')
        throw new TypeError('Description must be text');
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      if (
        !Object.hasOwn(schema, key) ||
        !schema[key] ||
        typeof schema[key] !== 'object'
      )
        throw new TypeError(
          'Descriptions cannot change action arguments: ' + key,
        );
      Object.defineProperty(result, key, {
        value: describe(
          schema[key],
          value,
          !Array.isArray(schema[key]) &&
            (!allowDescription || key !== 'properties'),
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (
    Object.hasOwn(metadata, '$position') &&
    (!Object.hasOwn(metadata, 'description') ||
      !Number.isInteger(metadata.$position) ||
      metadata.$position < 0 ||
      metadata.$position > Object.keys(schema).length)
  )
    throw new TypeError('Invalid description position');
  if (allowDescription && Object.hasOwn(metadata, 'description')) {
    const entries = Object.entries(result).filter(
      ([key]) => key !== 'description',
    );
    entries.splice(metadata.$position ?? entries.length, 0, [
      'description',
      metadata.description,
    ]);
    return Object.fromEntries(entries);
  }
  return result;
}
