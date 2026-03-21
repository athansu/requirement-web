import type { Annotation } from '../types';

interface AnnotationListProps {
  annotations: Annotation[];
  onRemove: (id: string) => void;
  onUpdateContent: (id: string, content: string) => void;
}

export function AnnotationList({ annotations, onRemove, onUpdateContent }: AnnotationListProps) {
  if (annotations.length === 0) {
    return (
      <section className="annotations-sidebar">
        <h3>标注列表</h3>
        <p style={{ color: '#9fb2cc', fontSize: '1rem', lineHeight: 1.7 }}>
          在文档中选中文字后，选择「修改」「删除」或「补充」以添加标注。可多次选中不同段落，添加多条标注。完成所有标注后点击「按标注修订」。
        </p>
      </section>
    );
  }
  return (
    <section className="annotations-sidebar">
      <h3>标注列表 ({annotations.length})</h3>
      {annotations.map((a) => (
        <div key={a.id} className="annotation-card">
          <span className="annotation-type">{a.type === 'modify' ? '修改' : a.type === 'delete' ? '删除' : '补充'}</span>
          <p className="annotation-quote">{a.quote.slice(0, 80)}{a.quote.length > 80 ? '…' : ''}</p>
          {(a.type === 'modify' || a.type === 'supplement') && (
            <textarea
              className="annotation-edit"
              value={a.content ?? ''}
              onChange={(e) => onUpdateContent(a.id, e.target.value)}
              placeholder="内容"
              rows={2}
            />
          )}
          <button type="button" className="annotation-remove" onClick={() => onRemove(a.id)}>移除</button>
        </div>
      ))}
    </section>
  );
}
