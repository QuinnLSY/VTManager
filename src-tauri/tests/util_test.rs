use vtmanager_lib::util::{civil_to_ms, kind_of, parse_exif_datetime, validate_name};

#[test]
fn exif_datetime_parse() {
    assert_eq!(
        parse_exif_datetime("2024:03:15 10:20:30"),
        Some(civil_to_ms(2024, 3, 15, 10, 20, 30))
    );
    assert_eq!(parse_exif_datetime("not a date"), None);
    assert_eq!(parse_exif_datetime("2024:13:99 99:99:99"), None);
}

#[test]
fn kind_detection() {
    assert_eq!(kind_of("a.mp4", false), "video");
    assert_eq!(kind_of("b.MKV", false), "video");
    assert_eq!(kind_of("c.jpg", false), "image");
    assert_eq!(kind_of("d.HEIC", false), "image");
    assert_eq!(kind_of("e.srt", false), "doc");
    assert_eq!(kind_of("f.xyz", false), "other");
    assert_eq!(kind_of("g", true), "dir");
}

#[test]
fn name_validation() {
    assert!(validate_name("钢铁侠2008").is_ok());
    assert!(validate_name("").is_err());
    assert!(validate_name("a/b").is_err());
    assert!(validate_name("..").is_err());
    assert!(validate_name("  ").is_err());
}
