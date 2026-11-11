<script setup>
import {
  Search,
  Settings,
  KeyRound,
  Layers,
  Plane,
  Satellite,
  Ship,
  TrainFront,
  Car,
  Bike,
  Video,
  MapPin,
  Radar,
  Cloud,
  Server,
  Building2,
  Cable,
  Waves,
  Radio,
  TriangleAlert,
  SlidersHorizontal,
  Eye,
  X,
  ChevronDown,
  Sparkles,
  MessageSquare,
  Mic,
  ExternalLink,
  Play,
  Pause,
} from '@lucide/vue';
/** Inline line icons in Minimal; the original glyphs in other skins. */
defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 18 },
});
const icons = {
  search: Search,
  settings: Settings,
  key: KeyRound,
  layers: Layers,
  flight: Plane,
  satellite_alt: Satellite,
  directions_boat: Ship,
  train: TrainFront,
  car: Car,
  bike: Bike,
  videocam: Video,
  streetview: MapPin,
  place: MapPin,
  radar: Radar,
  cloud: Cloud,
  server: Server,
  building: Building2,
  cable: Cable,
  water: Waves,
  radio: Radio,
  warning: TriangleAlert,
  tune: SlidersHorizontal,
  eye: Eye,
  close: X,
  chevron_down: ChevronDown,
  sparkles: Sparkles,
  chat: MessageSquare,
  mic: Mic,
  open_in_new: ExternalLink,
  play_arrow: Play,
  pause: Pause,
};
</script>

<template>
  <span
    class="ui-icon material-symbols-outlined"
    :style="{ fontSize: `${size}px` }"
    aria-hidden="true"
  >
    <component
      :is="icons[name] ?? Layers"
      class="ui-line-icon"
      :size="size"
      :stroke-width="1.6"
      aria-hidden="true"
    />
    <span class="ui-material-icon">{{ name }}</span>
  </span>
</template>
