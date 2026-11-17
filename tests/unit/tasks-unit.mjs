import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTasks, validateTasks, validDate, descendants } from '../../src/tasks/model.ts'
const id=()=>crypto.randomUUID()
function row(){return {id:id(),title:'离线任务',description:'',notes:'',projectId:null,sectionId:null,parentId:null,priority:4,labelIds:[],order:1,expanded:true,planDate:null,completedAt:null,deletedAt:null,createdAt:1,updatedAt:1,revision:0}}
test('task dates are strict calendar dates; trees reject cycles, dangling references and unknown fields',()=>{
 assert.equal(validDate('2028-02-29'),true);assert.equal(validDate('2027-02-29'),false);assert.equal(validDate('2027-04-31'),false)
 const data=emptyTasks(),parent=row(),child={...row(),parentId:parent.id};data.tasks.push(parent,child);validateTasks(data);assert.deepEqual([...descendants(data.tasks,[parent.id])],[parent.id,child.id])
 for(const mutate of [d=>d.tasks[0].parentId=child.id,d=>d.tasks[0].parentId='',d=>d.tasks[0].projectId=id(),d=>d.tasks[0].labelIds=[id()],d=>d.tasks[0].unknown='bad',d=>d.tasks.push({...parent}),d=>d.tasks[0].title='']){const invalid=structuredClone(data);mutate(invalid);assert.throws(()=>validateTasks(invalid))}
})
