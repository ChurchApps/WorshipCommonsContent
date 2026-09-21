"""Deterministic zip: python -m zipfile stamps each entry with the file's mtime, so the same
files zipped on two machines give two different archives. Fixed timestamp, sorted entries,
root-level names. usage: zip.py <out.zip> <file>..."""
import sys, zipfile, os

EPOCH = (1980, 1, 1, 0, 0, 0)  # earliest DOS time zipfile accepts


def write(out, files):
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for f in sorted(files, key=os.path.basename):
            info = zipfile.ZipInfo(os.path.basename(f), date_time=EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(f, "rb") as fh:
                z.writestr(info, fh.read())


if __name__ == "__main__":
    write(sys.argv[1], sys.argv[2:])
