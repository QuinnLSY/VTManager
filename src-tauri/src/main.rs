#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vtmanager_lib::commands::run();
}

