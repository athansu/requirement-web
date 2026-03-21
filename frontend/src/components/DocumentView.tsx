import { useRef, useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnnotationAnchorPolicy, AnnotationType } from '../types';

interface DocumentViewProps {
  document: string;
  onAddAnnotation: (
    type: AnnotationType,
    quote: string,
    content?: string,
    anchorPolicy?: AnnotationAnchorPolicy
  ) => void;
}

type BubbleType = 'modify' | 'supplement';

const BUBBLE_EST_HEIGHT = 220;
const BUBBLE_WIDTH = 320;

export function DocumentView({ document: docContent, onAddAnnotation }: DocumentViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<{
    x: number;
    y: number;
    text: string;
    rect: { right: number; top: number; height: number };
  } | null>(null);
  const [bubble, setBubble] = useState<{
    type: BubbleType;
    quote: string;
    initialValue: string;
    right: number;
    top: number;
  } | null>(null);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (bubble) setInputValue(bubble.initialValue);
  }, [bubble]);

  const closeBubble = useCallback(() => {
    setBubble(null);
    setInputValue('');
  }, []);

  useEffect(() => {
    if (!bubble) return;
    const doc = window.document;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (bubbleRef.current?.contains(target) || toolbarRef.current?.contains(target)) return;
      closeBubble();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeBubble();
    };
    doc.addEventListener('mousedown', onMouseDown, true);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('mousedown', onMouseDown, true);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [bubble, closeBubble]);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Node;
      if (toolbarRef.current?.contains(target) || bubbleRef.current?.contains(target)) return;
      if (bubble) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!text || !containerRef.current) {
        setToolbar(null);
        return;
      }
      try {
        const range = sel!.getRangeAt(0);
        if (!containerRef.current.contains(range.commonAncestorContainer)) {
          setToolbar(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        if (!rect) {
          setToolbar(null);
          return;
        }
        setToolbar({
          x: rect.left + rect.width / 2,
          y: rect.bottom + 8,
          text,
          rect: { right: rect.right, top: rect.top, height: rect.height },
        });
      } catch {
        setToolbar(null);
      }
    },
    [bubble]
  );

  const add = useCallback(
    (type: AnnotationType) => {
      if (!toolbar) return;
      if (type === 'delete') {
        onAddAnnotation('delete', toolbar.text, undefined, 'delete_selected');
        setToolbar(null);
        window.getSelection()?.removeAllRanges();
        return;
      }
      if (type === 'modify') {
        setBubble({
          type: 'modify',
          quote: toolbar.text,
          initialValue: toolbar.text,
          right: toolbar.rect.right,
          top: toolbar.rect.top,
        });
      } else {
        setBubble({
          type: 'supplement',
          quote: toolbar.text,
          initialValue: '',
          right: toolbar.rect.right,
          top: toolbar.rect.top,
        });
      }
      setToolbar(null);
      window.getSelection()?.removeAllRanges();
    },
    [toolbar, onAddAnnotation]
  );

  const submitBubble = useCallback(() => {
    if (!bubble) return;
    const content = inputValue.trim();
    if (bubble.type === 'modify' && content) {
      onAddAnnotation('modify', bubble.quote, content, 'replace_selected');
    }
    if (bubble.type === 'supplement' && content) {
      onAddAnnotation('supplement', bubble.quote, content, 'insert_after_selected');
    }
    setBubble(null);
    setInputValue('');
  }, [bubble, inputValue, onAddAnnotation]);

  const bubbleTop = bubble
    ? (() => {
        const desired = bubble.top - 8;
        const minTop = 12;
        const maxTop = typeof window !== 'undefined' ? window.innerHeight - BUBBLE_EST_HEIGHT - 12 : desired;
        return Math.min(Math.max(minTop, desired), maxTop);
      })()
    : 0;
  const bubbleLeft = bubble
    ? (() => {
        const desired = bubble.right + 12;
        const minLeft = 12;
        const maxLeft = typeof window !== 'undefined' ? window.innerWidth - BUBBLE_WIDTH - 12 : desired;
        return Math.min(Math.max(minLeft, desired), maxLeft);
      })()
    : 0;

  return (
    <div ref={containerRef} className="doc-content" onMouseUp={handleMouseUp}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {docContent ?? ''}
      </ReactMarkdown>
      {toolbar && (
        <div
          ref={toolbarRef}
          className="annotation-toolbar"
          style={{ left: toolbar.x, top: toolbar.y, transform: 'translate(-50%, 0)' }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <button type="button" className="toolbar-btn-modify" onClick={() => add('modify')}>修改</button>
          <button type="button" className="toolbar-btn-delete" onClick={() => add('delete')}>删除</button>
          <button type="button" className="toolbar-btn-supplement" onClick={() => add('supplement')}>补充</button>
        </div>
      )}
      {bubble && (
        <div
          ref={bubbleRef}
          className="annotation-bubble"
          style={{ left: bubbleLeft, top: bubbleTop }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="annotation-bubble-arrow" />
          <div className="annotation-bubble-title">
            {bubble.type === 'modify' ? '修改为' : '补充内容'}
          </div>
          <textarea
            className="annotation-bubble-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={bubble.type === 'modify' ? '输入修改后的内容…' : '输入要补充的内容…'}
            rows={3}
            autoFocus
          />
          <div className="annotation-bubble-actions">
            <button type="button" className="bubble-btn-cancel" onClick={closeBubble}>取消</button>
            <button
              type="button"
              className="bubble-btn-confirm"
              onClick={submitBubble}
              disabled={!inputValue.trim()}
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
