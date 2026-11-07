"use strict";
/* Snappy's view over a site (snappy-view.html), loaded before the card
   (snappy-card.js): what the card needs of the app's page, then its hooks.
   window.__SNAPPY__ (library.rs): { lang, context }, the context its
   messages carry. Closing, widening and signing in go back to the app,
   which owns the card and places this view. */

const $ = (id) => document.getElementById(id);
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const SNAP_VIEW = window.__SNAPPY__ || { context: {} };
const snappyViewAction = (what) => invoke("snappy_view_action", { action: { what } }).catch(() => {});

document.addEventListener("DOMContentLoaded", () => {
  Object.assign(SNAP_PAGE, {
    context: () => SNAP_VIEW.context || {},
    close: () => snappyViewAction("close"),
    wide: () => snappyViewAction("wide"),
    auth: () => snappyViewAction("auth"),
  });
  // The app sets the width: the corner button tells which way it goes.
  const wide = () => $("snappy").classList.toggle("wide", innerWidth > 480);
  window.addEventListener("resize", wide);
  wide();
  SNAP.open = true;
  snappyLoad();
  $("snappy-input").focus();
});
