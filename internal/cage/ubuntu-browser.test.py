from pathlib import Path
import unittest
from tempfile import TemporaryDirectory

# The guest launcher is embedded verbatim in its provisioning script.
source = Path(__file__).with_name("ubuntu-browser.sh").read_text().split("<<'PYLAUNCH'\n", 1)[1].split("\nPYLAUNCH\n", 1)[0]
launcher = {"__name__": "test_launcher"}
exec(compile(source, "ubuntu-chromium-launcher", "exec"), launcher)


class ProfileMigration(unittest.TestCase):
    def test_select_storage_without_displacing_new_data(self):
        with TemporaryDirectory() as tmp:
            profile = Path(tmp)
            default = profile / "Default"
            default.mkdir()
            def selected():
                return launcher["uses_sqlite"](profile)

            self.assertFalse(selected())
            local = default / "Local Storage" / "leveldb"
            local.mkdir(parents=True)
            self.assertFalse(selected())
            (default / "LocalStorage").write_bytes(b"SQLite format 3\x00")
            self.assertTrue(selected())
            # Chromium 157 writes a version record in each empty LevelDB.
            # Its session store also issues a zero-operation write batch.
            log = local / "000003.log"
            log.write_bytes(bytes.fromhex("9a1bdc35170001010000000000000001000000010756455253494f4e0131"))
            session = default / "Session Storage"
            session.mkdir()
            (session / "000003.log").write_bytes(bytes.fromhex(
                "f9be6a2b170001010000000000000001000000010776657273696f6e0131"
                "acc7460e0c0001020000000000000000000000"))
            self.assertTrue(selected())
            self.assertTrue(selected())
            log.write_bytes(log.read_bytes() + b"unknown or nonempty record")
            self.assertFalse(selected())
            log.unlink()
            (session / "000004.ldb").write_bytes(b"nonempty site data")
            self.assertFalse(selected())


if __name__ == "__main__":
    unittest.main()
