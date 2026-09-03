<script setup lang="ts">
import { store } from "../store";
</script>

<template>
  <div class="toasts">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div>
  </div>
</template>
