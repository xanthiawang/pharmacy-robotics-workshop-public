"""Build the teaching stations from the distributed pharmacy model and controller."""
import ast
import json
from copy import deepcopy
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

DOWNLOADS = Path(__file__).resolve().parents[1] / "docs" / "downloads"
XML = "assets/pharmacy/pharmacy.xml"

def put(body, xyz, rotation=None):
    body.set("pos", " ".join(map(str, xyz)))
    if rotation is not None:
        body.set("quat", " ".join(map(str, rotation)))

def build(station):
    with ZipFile(DOWNLOADS / "pharmacy-pick-place.botlab.zip") as source:
        files = {p: source.read(p) for p in source.namelist()}
    model = ET.fromstring(files[XML])
    model.set("model", station)
    world = model.find("worldbody")
    def body(name):
        return world.find(f"body[@name='{name}']")
    controller = files["controller.py"].decode()
    def values(key):
        return json.loads(re.search(rf"^{key}=(.*)$", controller, re.M)[1])
    poses, times = values("TARGETS"), values("STEPS")
    init = re.search(r"'initialQpos': (\[[^\]]+\])", controller)
    q = ast.literal_eval(init[1])
    world.remove(body("destination_bin"))
    if station == "returns":
        for stack in (1, 2):
            for layer in range(3):
                world.remove(body(f"return_bin_{stack}_{layer}"))
        box = [1.29, .55, .762]
        rot = [1, 0, 0, 0]
        put(body("robot_station"), [box[0]+.55, box[1]+.13, 0], rot)
        poses = [poses[i] for i in (0, 1, 2, 3, 4, 2, 1, 0)]
        times = [50, 150, 100, 150, 150, 175, 100, 150]
        title = "Return desk - lift, hold and replace"
    else:
        rack = body("dispatch_rack")
        rack.remove(rack.find("body[@name='dispatch_rack__shelf3']"))
        box = [2.94, .83, .762]
        rot = [0, 0, 0, 1]
        put(body("robot_station"), [box[0]-.55, box[1]-.13, 0], rot)
        table = deepcopy(body("return_table"))
        for item in table.iter():
            if "name" in item.attrib:
                item.set("name", item.get("name").replace("return_table","staging_table"))
        put(table,[2.94, 1.41, 0],[.7071067811865476, 0, 0, .7071067811865476])
        world.append(table)
        title = "Dispatch rack - stock middle shelf"
    put(body("test_medicine_box"), box, rot)
    # The free joint is last in this source model, following the 18 arm/hand joints.
    assert len(q) == 25 and q[-4:] == [1, 0, 0, 0]
    q[-7:] = box + rot
    controller = controller[:init.start(1)] + json.dumps(q) + controller[init.end(1):]
    for key, vals in (("TARGETS",poses),("STEPS",times)):
        controller = re.sub(rf"^{key}=.*$",key+"="+json.dumps(vals),controller,flags=re.M)
    files["controller.py"] = controller.replace("Pharmacy Handle-L1 pick and place",title).encode()
    files[XML] = ET.tostring(model,encoding="utf-8")
    files["README.md"] = (title+"\n\n"+files["README.md"].decode().split("Run the 25-second")[0].strip()+"\n").encode()
    with ZipFile(DOWNLOADS / f"pharmacy-{station}.botlab.zip","w",ZIP_DEFLATED) as result:
        for path, data in files.items():
            result.writestr(path, data)

if __name__ == "__main__":
    for name in ("returns", "dispatch"):
        build(name)
