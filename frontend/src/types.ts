export type AnnotationType = 'modify' | 'delete' | 'supplement';
export type AnnotationAnchorPolicy = 'replace_selected' | 'delete_selected' | 'insert_after_selected';

export interface Annotation {
  id: string;
  type: AnnotationType;
  quote: string;
  content?: string;
  anchorPolicy?: AnnotationAnchorPolicy;
}
