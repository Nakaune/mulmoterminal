<script setup lang="ts">
// The roster row's copy of the session-PR chip.
//
// A wrapper and not a second chip: the cockpit lists SESSIONS, and a session's requests are fetched
// per session (useSessionPrs), which a composable cannot do from inside the parent's `v-for`. So the
// row hands a session id to this, and this holds the one poller that row needs.
//
// The header chip and this one can both be live for the same session — the expanded cell and its
// roster row. That costs one extra request per 30s per visible row and no correctness: the server
// answers from a store it already keeps, and both readers see the same list.
//
// `hidePr` is not taken. The header hides the request WorkItemChip is drawing a few pixels away;
// the roster row draws a phase pill and no number at all, so there is nothing here to collide with.
import { toRef } from "vue";
import SessionPrsChip from "./SessionPrsChip.vue";
import { useSessionPrs } from "../composables/useSessionPrs";

const props = defineProps<{ sessionId: string | null }>();
const { prs } = useSessionPrs(toRef(props, "sessionId"));
</script>

<template>
  <SessionPrsChip :prs="prs" :hide-pr="null" />
</template>
