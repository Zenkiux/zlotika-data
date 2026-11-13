# Reads leaflet page images with PaddleOCR and prints JSON lines: one per page,
# {"image": path, "lines": [{"text", "box":[x,y,w,h], "conf"}]}. Used by the collector
# as the open-source fallback when the vision model is unavailable.
import json, sys, time
from paddleocr import PaddleOCR

ocr = PaddleOCR(lang='pl', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
                text_detection_model_name='PP-OCRv5_mobile_det')
for path in sys.argv[1:]:
    t = time.time()
    res = ocr.predict(path)[0]
    lines = []
    for text, poly, conf in zip(res['rec_texts'], res['rec_polys'], res['rec_scores']):
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        lines.append({'text': text, 'box': [int(min(xs)), int(min(ys)), int(max(xs) - min(xs)), int(max(ys) - min(ys))], 'conf': round(float(conf), 3)})
    print(json.dumps({'image': path, 'secs': round(time.time() - t, 1), 'lines': lines}, ensure_ascii=False), flush=True)
