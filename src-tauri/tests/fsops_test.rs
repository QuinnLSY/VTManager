use std::path::PathBuf;
use vtmanager_lib::state::AppState;
use vtmanager_lib::{db, fsops};

fn temp_lib(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vtm_test_{}_{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn full_file_lifecycle() {
    let root = temp_lib("lifecycle");
    let state = AppState::new();

    // 造测试文件
    std::fs::write(root.join("a.mp4"), b"video").unwrap();
    std::fs::write(root.join("b.jpg"), b"image").unwrap();
    std::fs::create_dir(root.join("sub")).unwrap();

    state.open_library(&root).unwrap();

    // 列目录
    let listing = fsops::list_dir(&state, root.to_str().unwrap()).unwrap();
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["a.mp4", "b.jpg", "sub"]);

    // 建目录 + 重名自动加后缀
    let p1 = fsops::create_dir(&state, root.to_str().unwrap(), "新建文件夹").unwrap();
    let p2 = fsops::create_dir(&state, root.to_str().unwrap(), "新建文件夹").unwrap();
    assert_ne!(p1, p2);
    assert!(p2.ends_with("新建文件夹 (2)"));

    // 重命名（含扩展名修改）
    let a_path = root.join("a.mp4").to_string_lossy().to_string();
    let new_path = fsops::rename_entry(&state, &a_path, "c.mov").unwrap();
    assert!(PathBuf::from(&new_path).exists());
    assert!(!root.join("a.mp4").exists());

    // 重命名同步索引引用
    {
        let (_, guard) = state.conn().unwrap();
        let conn = guard.get().unwrap();
        conn.execute(
            "INSERT INTO index_entries (path, parent, name, is_dir, kind) VALUES (?1, ?2, 'c.mov', 0, 'video')",
            rusqlite::params![new_path, root.to_string_lossy().to_string()],
        ).unwrap();
        db::rename_refs(conn, &new_path, &root.join("d.mov").to_string_lossy()).unwrap();
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE name = 'd.mov'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 1);
    }
    std::fs::rename(&new_path, root.join("d.mov")).unwrap();

    // 删除 → 回收站 → 恢复
    let b_path = root.join("b.jpg").to_string_lossy().to_string();
    fsops::delete_entries(&state, vec![b_path.clone()]).unwrap();
    assert!(!root.join("b.jpg").exists());
    let trash = fsops::list_trash(&state).unwrap();
    assert_eq!(trash.len(), 1);
    fsops::restore_trash(&state, vec![trash[0].id.clone()]).unwrap();
    assert!(root.join("b.jpg").exists());
    assert!(fsops::list_trash(&state).unwrap().is_empty());

    // 移动
    let d_path = root.join("d.mov").to_string_lossy().to_string();
    let sub = root.join("sub").to_string_lossy().to_string();
    fsops::move_entries(&state, vec![d_path], &sub).unwrap();
    assert!(root.join("sub").join("d.mov").exists());
    assert!(!root.join("d.mov").exists());

    // 禁止移进自身子目录
    let sub_clone = sub.clone();
    assert!(fsops::move_entries(&state, vec![sub_clone.clone()], &sub_clone).is_err());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn search_index_query() {
    let root = temp_lib("search");
    let state = AppState::new();
    state.open_library(&root).unwrap();
    {
        let (_, guard) = state.conn().unwrap();
        let conn = guard.get().unwrap();
        conn.execute(
            "INSERT INTO index_entries (path, parent, name, name_py, py_initial, is_dir, kind) VALUES
            ('/x/钢铁侠2008', '/x', '钢铁侠2008', 'gangtiexia2008', 'gtx2008', 0, 'video')",
            [],
        )
        .unwrap();
    }
    let r = vtmanager_lib::commands::do_search(&state, "钢铁").unwrap();
    assert_eq!(r.len(), 1);
    let r = vtmanager_lib::commands::do_search(&state, "gtx").unwrap();
    assert_eq!(r.len(), 1);
    let r = vtmanager_lib::commands::do_search(&state, "2008").unwrap();
    assert_eq!(r.len(), 1);
    let r = vtmanager_lib::commands::do_search(&state, "不存在").unwrap();
    assert!(r.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}
