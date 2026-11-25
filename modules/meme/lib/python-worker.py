"""Offline JSON-lines adapter; one shared path for every Python template."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import traceback

home = Path(os.environ['MEME_PYTHON_HOME'])
source = home / 'source'
sys.path[:0] = [str(source), str(home / 'site-packages')]
wire = sys.stdout
sys.stdout = sys.stderr  # Upstream diagnostic prints must not corrupt the protocol.
excluded = set(json.loads((home / 'excluded.json').read_text('utf-8')))
os.environ['MEME_EXCLUDED_KEYS'] = json.dumps(sorted(excluded))

# Keep configuration/cache in the module, without changing the user's Python setup.
spec = importlib.util.spec_from_file_location('meme_generator.dirs', source / 'meme_generator/dirs.py')
dirs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dirs)
for name, folder in [('BASE_CONFIG_DIR','config'),('BASE_DATA_DIR','data'),('BASE_CACHE_DIR','cache')]:
    path = home / folder
    path.mkdir(parents=True, exist_ok=True)
    setattr(dirs, name, path)
sys.modules['meme_generator.dirs'] = dirs
(home / 'config/config.toml').write_text('[meme]\nmeme_disabled_list = ' + json.dumps(sorted(excluded)) + '\n[resource]\nresource_urls = []\n[gif]\ngif_max_size = 20\ngif_max_frames = 200\n', 'utf-8')

# Rendering may read installed assets, but must not call external APIs or download fonts.
def offline_connect(*args, **kwargs):
    raise RuntimeError('此模板尝试联网；当前仅允许离线生成')
socket.socket.connect = offline_connect
socket.create_connection = offline_connect

# Fail before native paragraph creation, rather than aborting the worker.
if sys.platform == 'win32' and not (home / 'site-packages/icudtl.dat').is_file():
    raise RuntimeError('Skia ICU data missing; run scripts/prepare-python.mjs')

import skia
import importlib
typography = importlib.import_module('pil_utils.text2image')
provider = skia.textlayout.TypefaceFontProvider()
font_dirs = [Path(os.environ.get('MEME_HOME', str(Path(os.environ['MEME_MODULE_DIR']) / 'node_modules/.meme-runtime'))) / 'resources/fonts', source / 'resources/fonts']
for folder in font_dirs:
    for font in sorted(folder.glob('*')):
        if font.suffix.lower() in ('.ttf', '.otf', '.ttc'):
            face = skia.Typeface.MakeFromFile(str(font))
            if face:
                provider.registerTypeface(face)
typography.font_collection.setDefaultFontManager(provider)
if hasattr(typography, 'DEFAULT_FALLBACK_FONTS'):
    typography.DEFAULT_FALLBACK_FONTS.insert(0, 'Noto Sans SC')

# Detect import failures once, by metadata loading; no template is rendered here.
from loguru import logger
failures = []
def capture_error(message):
    if 'Failed to import' in message.record['message']:
        failures.append(message.record['message'])
logger.add(capture_error, level='ERROR')
# Execute the framework initializer with an ID-based loader filter in memory.
# The installed source and individual template files remain unchanged.
init = source / 'meme_generator/__init__.py'
spec = importlib.util.spec_from_file_location('meme_generator', init, submodule_search_locations=[str(init.parent)])
library = importlib.util.module_from_spec(spec)
sys.modules['meme_generator'] = library
loader = init.read_text('utf-8').replace('if path.is_dir():', 'if path.is_dir() and path.name not in _dsh_excluded:')
library.__dict__['_dsh_excluded'] = excluded
skip_file = home / 'skipped-directories.json'
skipped = set(json.loads(skip_file.read_text('utf-8'))) if skip_file.exists() else set()
library.__dict__['_dsh_skipped'] = skipped
library.__dict__['_dsh_loaded_dirs'] = {}
loader = loader.replace('and path.name not in _dsh_excluded:', 'and path.name not in _dsh_excluded and str(path.relative_to(Path(__file__).parent)).replace(chr(92), "/") not in _dsh_skipped:')
loader = loader.replace('            load_meme(f"{module_prefix}.{path.name}")', '            _before = set(get_meme_keys())\n            load_meme(f"{module_prefix}.{path.name}")\n            _dsh_loaded_dirs[str(path.relative_to(Path(__file__).parent)).replace(chr(92), "/")] = sorted(set(get_meme_keys()) - _before)')
exec(compile(loader, str(init), 'exec'), library.__dict__)


def info(meme):
    p = meme.params_type
    options = []
    if p.args_type:
        model = p.args_type.args_model
        schema = model.model_json_schema() if hasattr(model,'model_json_schema') else model.schema()
        for name, prop in schema.get('properties',{}).items():
            if name == 'user_infos':
                continue
            kind = prop.get('type')
            if not kind:
                kind = next((x.get('type') for x in prop.get('anyOf',[]) if x.get('type') != 'null'), None)
            kind = {'string':'String','integer':'Integer','number':'Float','boolean':'Boolean'}.get(kind)
            if not kind:
                continue
            field = {'name':name,'description':prop.get('description','')}
            for k in ('default','minimum','maximum'):
                if prop.get(k) is not None:
                    field[k] = prop[k]
            aliases = []
            for opt in p.args_type.parser_options:
                if (opt.dest or (opt.args[0].name if opt.args else '')) == name:
                    aliases += [n.lstrip('-') for n in opt.names]
                    field['description'] = field['description'] or opt.help_text or ''
            field['parserFlags'] = {'longAliases':aliases,'shortAliases':[]}
            options.append({'type':kind,'field0':field})
    return {'key':meme.key,'keywords':meme.keywords or [meme.key],'tags':sorted(meme.tags),'shortcuts':[],
            'params':{'minImages':p.min_images,'maxImages':p.max_images,'minTexts':p.min_texts,'maxTexts':p.max_texts,'defaultTexts':p.default_texts,'options':options},'backend':'python'}

memes = {m.key:m for m in library.get_memes() if m.key not in excluded}
from meme_generator.exception import TextOverLength, OpenImageFailed, ArgModelMismatch

class OutputTooLarge(Exception):
    pass

user_errors = (TextOverLength, OpenImageFailed, ArgModelMismatch, OutputTooLarge)
if '--catalog' in sys.argv:
    if not all(k in memes for k in ['masturbate','huochailu']):
        raise RuntimeError('指定模板标识未载入：masturbate / huochailu')
    if failures:
        raise RuntimeError('模板导入失败：' + '; '.join(failures))
    catalog = [info(m) for m in sorted(memes.values(),key=lambda m:m.key)]
    active = {directory for directory, keys in library._dsh_loaded_dirs.items() if keys}
    for meme in memes.values():
        parts = meme.function.__module__.split('.')
        if len(parts) >= 3 and parts[0] == 'meme_generator':
            active.add('/'.join(parts[1:3]))
    (home / 'active-directories.json').write_text(json.dumps(sorted(active)), 'utf-8')
    (home / 'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False), 'utf-8')
    print(json.dumps({'templates':len(catalog),'requiredKeys':all(k in memes for k in ['masturbate','huochailu'])}),file=wire,flush=True)
    sys.exit(0)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        meme = memes[request['key']]
        options = {k:v.get('field0') for k,v in request.get('options',{}).items()}
        images = request.get('images',[])
        options['user_infos'] = [{'name':im.get('name') or '你好','gender':'unknown'} for im in images]
        if request['op'] == 'preview':
            result = meme.generate_preview(args=options)
        else:
            result = meme(images=[base64.b64decode(im['data']) for im in images],texts=request.get('texts',[]),args=options)
        data = result.getvalue()
        if len(data)>20*1024*1024:
            raise OutputTooLarge('生成结果超过 20 MB，请缩小输入图片')
        reply = {'id':request['id'],'base64':base64.b64encode(data).decode('ascii')}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        reply = {'id':request.get('id'),'error':str(error) or type(error).__name__}
        for error_type in user_errors:
            if isinstance(error, error_type):
                reply['errorCode'] = error_type.__name__
                break
    print(json.dumps(reply,ensure_ascii=False),file=wire,flush=True)
