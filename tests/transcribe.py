import importlib.util, sys, types, unittest
from pathlib import Path
for name in ('imageio_ffmpeg','mlx_whisper','numpy'):
 sys.modules[name]=types.ModuleType(name)
p=str(Path(__file__).resolve().parent.parent / 'local_transcribe.py')
spec=importlib.util.spec_from_file_location('transcribe',p); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_host(self):
  self.assertTrue(m.is_youtube_url('https://www.youtube.com/watch?v=x'))
  self.assertTrue(m.is_youtube_url('https://youtu.be/x'))
  self.assertFalse(m.is_youtube_url('https://notyoutube.com/watch?v=x'))
 def test_original_selected(self):
  f=[{'acodec':'opus','vcodec':'none','language':'en-US','format_note':'English dubbed'}, {'acodec':'opus','vcodec':'none','language':'zh-Hant','format_note':'Chinese original (default)'}]
  self.assertEqual(m.youtube_original_audio_format({'formats':f}),'bestaudio[format_note*=original]')
 def test_single_language(self):
  self.assertEqual(m.youtube_original_audio_format({'formats':[{'acodec':'opus','vcodec':'none','language':'zh'}]}),'bestaudio/best')
 def test_ambiguous_language(self):
  f=[{'acodec':'opus','vcodec':'none','language':'en'},{'acodec':'opus','vcodec':'none','language':'zh'}]
  with self.assertRaisesRegex(RuntimeError,'多种音轨'):m.youtube_original_audio_format({'formats':f})
unittest.main(verbosity=2)
