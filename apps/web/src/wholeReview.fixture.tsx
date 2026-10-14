import {createRoot} from 'react-dom/client';
import {CandidateReviewWorkspace} from './components/CandidateReviewWorkspace';
import './styles.css';
import './candy.css';
document.documentElement.dataset.theme='light';
const taskId=new URLSearchParams(window.location.search).get('task')!;
createRoot(document.getElementById('root')!).render(<CandidateReviewWorkspace taskId={taskId} onClose={()=>{}} onEditDraft={()=>{}}/>);
