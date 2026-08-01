"""Rewrite the placement transform in a slicer-exported 3MF."""
import re
import shutil
import sys
import zipfile


def rewrite(src, dst, dx, dy, mode):
    zin = zipfile.ZipFile(src)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "3D/3dmodel.model":
                text = data.decode("utf-8")

                def sub_component(m):
                    nums = m.group(1).split()
                    nums[9] = str(float(nums[9]) + dx)
                    nums[10] = str(float(nums[10]) + dy)
                    return 'transform="' + " ".join(nums) + '"'

                text = re.sub(r'transform="([^"]+)"', sub_component, text, count=1)
                data = text.encode("utf-8")
            elif info.filename == "Metadata/model_settings.config" and mode == "both":
                text = data.decode("utf-8")

                def sub_matrix(m):
                    nums = m.group(1).split()
                    nums[3] = str(float(nums[3]) + dx)   # row-major 4x4, tx
                    nums[7] = str(float(nums[7]) + dy)   # ty
                    return 'key="matrix" value="' + " ".join(nums) + '"'

                text = re.sub(r'key="matrix" value="([^"]+)"', sub_matrix, text)
                text = re.sub(
                    r'key="source_offset_x" value="([^"]+)"',
                    lambda m: f'key="source_offset_x" value="{float(m.group(1)) + dx}"',
                    text,
                )
                text = re.sub(
                    r'key="source_offset_y" value="([^"]+)"',
                    lambda m: f'key="source_offset_y" value="{float(m.group(1)) + dy}"',
                    text,
                )
                data = text.encode("utf-8")
            zout.writestr(info, data)
    zin.close()


if __name__ == "__main__":
    src, dst, dx, dy, mode = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    rewrite(src, dst, dx, dy, mode)
    z = zipfile.ZipFile(dst)
    t = z.read("3D/3dmodel.model").decode()
    print("component transform now:", re.search(r'transform="([^"]+)"', t).group(1))
    if mode == "both":
        c = z.read("Metadata/model_settings.config").decode()
        print("matrix now:", re.search(r'key="matrix" value="([^"]+)"', c).group(1))
